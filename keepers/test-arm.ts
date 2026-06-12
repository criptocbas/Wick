/** Test: place_bet (clean) succeeds, then arm_resolution (separate) schedules a
 *  crank. Reports whether arm succeeds on this ER and whether it auto-resolves. */
import BN from "bn.js";
import {
  Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { makeCtx, pdas } from "./common";

const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR ?? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = makeCtx(); const P = pdas(ctx.programId); const SOL = 0;

async function main() {
  const user = Keypair.generate();
  await sendAndConfirmTransaction(ctx.base, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: ctx.admin.publicKey, toPubkey: user.publicKey, lamports: 50_000_000 })), [ctx.admin], { commitment: "confirmed" });
  const cfg: any = await (ctx.program.account as any).config.fetch(P.config); const mint = cfg.mint;
  const userPda = PublicKey.findProgramAddressSync([Buffer.from("user"), user.publicKey.toBuffer()], ctx.programId)[0];
  const ata = await getOrCreateAssociatedTokenAccount(ctx.base, ctx.admin, mint, user.publicKey);
  await mintTo(ctx.base, ctx.admin, mint, ata.address, ctx.admin, 1e9);
  const send = async (tx: Transaction) => { tx.feePayer = user.publicKey; tx.recentBlockhash = (await ctx.base.getLatestBlockhash()).blockhash; tx.sign(user); await ctx.base.confirmTransaction(await ctx.base.sendRawTransaction(tx.serialize(), { skipPreflight: true }), "confirmed"); };
  await send(await ctx.program.methods.initUser(user.publicKey).accounts({ authority: user.publicKey }).transaction());
  await send(await ctx.program.methods.deposit(new BN(1e8)).accounts({ authority: user.publicKey, from: ata.address }).transaction());
  await send(await ctx.program.methods.delegateUser().accounts({ payer: user.publicKey, userAccount: userPda }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]).transaction());
  await sleep(3000);
  const mkt: any = await (ctx.program.account as any).marketConfig.fetch(P.market(SOL));
  const feed: PublicKey = mkt.feed;
  const erSend = async (tx: Transaction, label: string) => {
    tx.feePayer = user.publicKey; tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash; tx.sign(user);
    const s = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 250; i++) { const st = await ctx.er.getSignatureStatus(s);
      if (st.value?.err) { const txi = await ctx.er.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); console.log(`${label} FAILED:`, JSON.stringify(st.value.err)); for (const l of (txi?.meta?.logMessages ?? []).slice(-6)) console.log("   ", l); return false; }
      if (st.value?.confirmationStatus) { console.log(`${label} ✓`); return true; } await sleep(20); }
    console.log(`${label} timeout`); return false;
  };
  const placed = await erSend(await ctx.program.methods.placeBet(1, new BN(1e7), 5).accounts({ operator: user.publicKey, market: P.market(SOL), book: P.book(SOL), house: P.house, userAccount: userPda, feed }).transaction(), "place_bet");
  if (!placed) return;
  const armed = await erSend(await ctx.program.methods.armResolution(0).accounts({ payer: user.publicKey, market: P.market(SOL), book: P.book(SOL), house: P.house, userAccount: userPda, feed, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT }).transaction(), "arm_resolution");
  if (!armed) { console.log("\n→ crank not supported on this ER; client/optimistic resolver is the active path (place_bet unaffected)"); return; }
  for (let i = 0; i < 15; i++) { await sleep(1000); const info = await ctx.er.getAccountInfo(userPda); const u: any = ctx.program.coder.accounts.decode("userAccount", info!.data);
    console.log(`  t+${i + 1}s openBets=${u.openBets}`); if (u.openBets === 0) { console.log(`\n✅ crank AUTO-RESOLVED on this ER (wins=${u.wins} losses=${u.losses})`); return; } }
  console.log("\n⚠ armed but did not auto-resolve in 15s");
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
