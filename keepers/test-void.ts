/**
 * Live void-path check: place a bet on an exotic (kind-1) market whose feed the
 * daemon is the sole writer of, then stop feeding it. With no qualifying print
 * in the settlement window, the bet must become voidable and refund the stake.
 *
 * Run with the daemon already FUNDING but about to be stopped:
 *   CLUSTER=devnet npx tsx test-void.ts        (kills the daemon itself mid-test)
 */
import BN from "bn.js";
import { execSync } from "node:child_process";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  CLUSTER,
  DAEMON_PORT,
  MARKETS,
  VALIDATOR,
  loadIdl,
  makeCtx,
  pdas,
} from "./common";

const DAEMON = process.env.DAEMON_URL ?? `http://localhost:${DAEMON_PORT}`;
const MARKET = MARKETS.find((m) => m.symbol === "NVDA")!; // kind-1, daemon-sole-writer
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = makeCtx();
  const P = pdas(ctx.programId);
  const burner = Keypair.generate();
  console.log(`burner ${burner.publicKey.toBase58()} on ${CLUSTER}, market ${MARKET.symbol}`);

  const fr = await fetch(`${DAEMON}/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: burner.publicKey.toBase58() }),
  });
  if (!fr.ok) throw new Error(`faucet: ${fr.status} ${await fr.text()}`);

  const program = new Program(
    loadIdl(),
    new AnchorProvider(ctx.base, new Wallet(burner), { commitment: "confirmed" })
  );
  const userPda = PublicKey.findProgramAddressSync(
    [Buffer.from("user"), burner.publicKey.toBuffer()],
    ctx.programId
  )[0];
  const mint = ((await (program.account as any).config.fetch(P.config)) as any).mint;
  const ata = getAssociatedTokenAddressSync(mint, burner.publicKey);
  for (let i = 0; i < 30; i++) {
    const bal = await ctx.base.getTokenAccountBalance(ata).catch(() => null);
    if (bal?.value.uiAmount) break;
    await sleep(800);
  }
  await (program.methods as any).initUser(burner.publicKey).accounts({ authority: burner.publicKey }).rpc();
  await (program.methods as any).deposit(new BN(100_000_000)).accounts({ authority: burner.publicKey, from: ata }).rpc();
  await (program.methods as any)
    .delegateUser()
    .accounts({ payer: burner.publicKey, userAccount: userPda })
    .remainingAccounts([{ pubkey: new PublicKey(VALIDATOR), isSigner: false, isWritable: false }])
    .rpc({ skipPreflight: true });
  for (let i = 0; i < 40; i++) {
    if (await ctx.er.getAccountInfo(userPda).catch(() => null)) break;
    await sleep(500);
  }
  console.log("onboarded; placing bet then killing the daemon so the feed freezes");

  const feedPda = P.feed(MARKET.symbol);
  const placeIx = await (program.methods as any)
    .placeBet(1, new BN(10_000_000), 5)
    .accounts({
      operator: burner.publicKey, market: P.market(MARKET.idx), book: P.book(MARKET.idx),
      house: P.house, userAccount: userPda, feed: feedPda,
    })
    .instruction();
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(placeIx);
      tx.feePayer = burner.publicKey;
      tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash;
      tx.sign(burner);
      const sig = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      for (let i = 0; i < 50; i++) {
        const st = await ctx.er.getSignatureStatus(sig);
        if (st.value?.err) throw new Error(JSON.stringify(st.value.err));
        if (st.value?.confirmationStatus) break;
        await sleep(100);
      }
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 5 && /InvalidWritableAccount|timeout|not.*delegat/i.test(msg)) { await sleep(1200); continue; }
      throw e;
    }
  }
  // Freeze the feed: stop the daemon now so no NVDA print can land in-window.
  try { execSync(`pkill -f "tsx daemon.t[s]"`); } catch { /* ok */ }
  console.log("bet placed, daemon stopped — feed is now frozen");

  // Try to void too early — must be rejected (window still open).
  const voidTx = async () => {
    const tx = await (program.methods as any)
      .voidBet(0)
      .accounts({
        resolver: burner.publicKey, market: P.market(MARKET.idx), book: P.book(MARKET.idx),
        house: P.house, userAccount: userPda, feed: feedPda,
      })
      .transaction();
    tx.feePayer = burner.publicKey;
    tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash;
    tx.sign(burner);
    const sig = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = await ctx.er.getSignatureStatus(sig);
      if (st.value?.err) throw new Error(JSON.stringify(st.value.err));
      if (st.value?.confirmationStatus) return;
      await sleep(100);
    }
    throw new Error("void confirm timeout");
  };

  let earlyRejected = false;
  try { await voidTx(); } catch (e) {
    earlyRejected = /1812|6020|BetNotVoidable/.test(e instanceof Error ? e.message : String(e));
    console.log(`early void correctly rejected: ${earlyRejected}`);
  }
  if (!earlyRejected) { console.error("✗ early void was NOT rejected"); process.exit(1); }

  // Wait out expiry(5s) + grace(3s) + VOID_DELAY(2s) + margin, then void.
  await sleep(13_000);
  await voidTx();
  const info = await ctx.er.getAccountInfo(userPda);
  const u: any = program.coder.accounts.decode("userAccount", info!.data);
  const ok = u.openBets === 0 && u.balance.toNumber() === 100_000_000 && u.pushes === 1;
  console.log(`after void: balance=${u.balance.toNumber() / 1e6} openBets=${u.openBets} pushes=${u.pushes}`);
  console.log(ok ? "✓ void refunded the stake on the live devnet ER" : "✗ unexpected post-void state");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
