/**
 * Crank autonomy test (localnet): place a bet, arm the on-chain crank, then
 * WAIT — with NO client-side resolve — and verify the bet settles itself.
 */
import BN from "bn.js";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { makeCtx, pdas, sendER } from "./common";

const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const DELEG = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = makeCtx();
const P = pdas(ctx.programId);
const SOL = 0; // market idx
const feedSym = "SOL";

async function main() {
  // Use a fresh user keypair funded by admin
  const user = Keypair.generate();
  console.log("user:", user.publicKey.toBase58());
  await ctx.base.confirmTransaction(
    await ctx.base.requestAirdrop(user.publicKey, 2_000_000_000),
    "confirmed"
  );

  const cfg: any = await (ctx.program.account as any).config.fetch(P.config);
  const mint = cfg.mint as PublicKey;
  const userPda = PublicKey.findProgramAddressSync(
    [Buffer.from("user"), user.publicKey.toBuffer()],
    ctx.programId
  )[0];
  const ata = await getOrCreateAssociatedTokenAccount(ctx.base, ctx.admin, mint, user.publicKey);
  await mintTo(ctx.base, ctx.admin, mint, ata.address, ctx.admin, 1_000_000_000);

  // init + deposit + delegate (all L1, signed by user)
  const send = async (tx: Transaction) => {
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await ctx.base.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const s = await ctx.base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await ctx.base.confirmTransaction(s, "confirmed");
    return s;
  };
  await send(
    await ctx.program.methods.initUser(user.publicKey).accounts({ authority: user.publicKey }).transaction()
  );
  await send(
    await ctx.program.methods.deposit(new BN(100_000_000)).accounts({ authority: user.publicKey, from: ata.address }).transaction()
  );
  await send(
    await ctx.program.methods.delegateUser().accounts({ payer: user.publicKey, userAccount: userPda })
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]).transaction()
  );
  await sleep(3000);
  console.log("user delegated ✓");

  const feed = P.feed(feedSym);
  const erSend = async (tx: Transaction) => {
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const s = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    // poll confirm
    for (let i = 0; i < 200; i++) {
      const st = await ctx.er.getSignatureStatus(s);
      if (st.value?.err) throw new Error(`ER tx err ${JSON.stringify(st.value.err)}`);
      if (st.value?.confirmationStatus) return s;
      await sleep(20);
    }
    throw new Error("er confirm timeout");
  };

  // place a 5s LONG SOL bet
  await erSend(
    await ctx.program.methods.placeBet(1, new BN(10_000_000), 5).accounts({
      operator: user.publicKey, market: P.market(SOL), book: P.book(SOL),
      house: P.house, userAccount: userPda, feed,
    }).transaction()
  );
  let u: any = await (async () => {
    const info = await ctx.er.getAccountInfo(userPda);
    return ctx.program.coder.accounts.decode("userAccount", info!.data);
  })();
  console.log(`bet placed: openBets=${u.openBets}, balance=${u.balance.toNumber() / 1e6}`);

  // arm the crank (crank signer derived in-program from the payer)
  await erSend(
    await ctx.program.methods.armResolution(0).accounts({
      payer: user.publicKey, market: P.market(SOL), book: P.book(SOL),
      house: P.house, userAccount: userPda, feed,
      magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).transaction()
  );
  console.log("crank armed ✓ — now waiting WITHOUT any client resolve…");

  // wait and poll — the crank should auto-resolve at ~5s
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const info = await ctx.er.getAccountInfo(userPda);
    u = ctx.program.coder.accounts.decode("userAccount", info!.data);
    console.log(`  t+${i + 1}s: openBets=${u.openBets} wins=${u.wins} losses=${u.losses} balance=${u.balance.toNumber() / 1e6}`);
    if (u.openBets === 0) {
      console.log(`\n✅ CRANK AUTO-RESOLVED the bet (no client resolve called). wins=${u.wins} losses=${u.losses} pushes=${u.pushes}`);
      return;
    }
  }
  console.log("\n❌ bet did NOT auto-resolve within 20s — crank did not fire");
  console.log("ER log tail:");
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
