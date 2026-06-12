/**
 * Folded-crank test: place_bet ALONE schedules its own resolution. No separate
 * arm, no client resolve. Verify the bet settles itself.
 */
import BN from "bn.js";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { makeCtx, pdas } from "./common";

const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = makeCtx();
const P = pdas(ctx.programId);
const SOL = 0;

async function main() {
  const user = Keypair.generate();
  await ctx.base.confirmTransaction(await ctx.base.requestAirdrop(user.publicKey, 2e9), "confirmed");
  const cfg: any = await (ctx.program.account as any).config.fetch(P.config);
  const mint = cfg.mint;
  const userPda = PublicKey.findProgramAddressSync(
    [Buffer.from("user"), user.publicKey.toBuffer()], ctx.programId)[0];
  const ata = await getOrCreateAssociatedTokenAccount(ctx.base, ctx.admin, mint, user.publicKey);
  await mintTo(ctx.base, ctx.admin, mint, ata.address, ctx.admin, 1e9);
  const send = async (tx: Transaction) => {
    tx.feePayer = user.publicKey; tx.recentBlockhash = (await ctx.base.getLatestBlockhash()).blockhash;
    tx.sign(user); await ctx.base.confirmTransaction(await ctx.base.sendRawTransaction(tx.serialize(), { skipPreflight: true }), "confirmed");
  };
  await send(await ctx.program.methods.initUser(user.publicKey).accounts({ authority: user.publicKey }).transaction());
  await send(await ctx.program.methods.deposit(new BN(1e8)).accounts({ authority: user.publicKey, from: ata.address }).transaction());
  await send(await ctx.program.methods.delegateUser().accounts({ payer: user.publicKey, userAccount: userPda }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]).transaction());
  await sleep(3000);

  const feed = P.feed("SOL");
  const erSend = async (tx: Transaction) => {
    tx.feePayer = user.publicKey; tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash; tx.sign(user);
    const s = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 200; i++) { const st = await ctx.er.getSignatureStatus(s);
      if (st.value?.err) { const txi = await ctx.er.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); console.log((txi?.meta?.logMessages ?? []).join("\n")); throw new Error(JSON.stringify(st.value.err)); }
      if (st.value?.confirmationStatus) return s; await sleep(20); }
    throw new Error("timeout");
  };

  // place_bet ONLY — it should schedule its own crank
  await erSend(await ctx.program.methods.placeBet(1, new BN(1e7), 5).accounts({
    operator: user.publicKey, market: P.market(SOL), book: P.book(SOL),
    house: P.house, userAccount: userPda, feed,
    magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
  }).transaction());
  console.log("place_bet sent (with folded crank schedule) — NO arm, NO client resolve");

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const info = await ctx.er.getAccountInfo(userPda);
    const u: any = ctx.program.coder.accounts.decode("userAccount", info!.data);
    console.log(`  t+${i + 1}s: openBets=${u.openBets} wins=${u.wins} losses=${u.losses}`);
    if (u.openBets === 0) { console.log(`\n✅ place_bet's folded crank AUTO-RESOLVED it. wins=${u.wins} losses=${u.losses} pushes=${u.pushes}`); return; }
  }
  console.log("\n❌ did not auto-resolve");
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
