/**
 * Live one-touch check on the real devnet ER. Onboards a burner, places a
 * touch-UP and a touch-DOWN bet (tight 0.1% barriers, 60s) on SOL, and does NOT
 * settle them from here. The daemon's sweeper must detect a barrier crossing and
 * win one via check_touch — proving continuous in-window monitoring on the ER.
 *
 *   CLUSTER=devnet npx tsx test-touch.ts   (daemon must be running)
 */
import BN from "bn.js";
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
  pythFeedPda,
  usesPythOracle,
} from "./common";

const DAEMON = process.env.DAEMON_URL ?? `http://localhost:${DAEMON_PORT}`;
const MARKET = MARKETS.find((m) => m.symbol === "SOL")!;
const BARRIER_BPS = 10; // 0.1% — near-certain to touch within 60s
const DURATION_S = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = makeCtx();
  const P = pdas(ctx.programId);
  const burner = Keypair.generate();
  console.log(`burner ${burner.publicKey.toBase58()} on ${CLUSTER}`);

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
  console.log("onboarded; placing touch-UP and touch-DOWN (0.1%, 60s) on SOL");

  const feedPda = usesPythOracle(MARKET) ? pythFeedPda(MARKET.pythId!) : P.feed(MARKET.symbol);
  const place = async (direction: number) => {
    const ix = await (program.methods as any)
      .placeTouchBet(direction, new BN(10_000_000), DURATION_S, BARRIER_BPS)
      .accounts({
        operator: burner.publicKey, market: P.market(MARKET.idx), book: P.book(MARKET.idx),
        house: P.house, userAccount: userPda, feed: feedPda,
      })
      .instruction();
    for (let attempt = 0; ; attempt++) {
      try {
        const tx = new Transaction().add(ix);
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
        throw new Error("confirm timeout");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 5 && /InvalidWritableAccount|timeout|not.*delegat/i.test(msg)) { await sleep(1200); continue; }
        throw e;
      }
    }
  };
  await place(1); // touch UP
  await place(0); // touch DOWN
  console.log("two touch bets placed — NOT settling from here; watching the daemon");

  const deadline = Date.now() + 75_000;
  let lastOpen = 2;
  for (;;) {
    await sleep(1500);
    const info = await ctx.er.getAccountInfo(userPda);
    const u: any = program.coder.accounts.decode("userAccount", info!.data);
    if (u.openBets !== lastOpen) {
      console.log(
        `  openBets=${u.openBets} wins=${u.wins} losses=${u.losses} balance=${u.balance.toNumber() / 1e6}`
      );
      lastOpen = u.openBets;
    }
    if (u.openBets === 0) {
      const h = await fetch(`${DAEMON}/health`).then((r) => r.json());
      const ok = u.wins >= 1; // at least one barrier was touched and won
      console.log(
        `${ok ? "✓" : "✗"} settled by the daemon: wins=${u.wins} losses=${u.losses}; swept=${JSON.stringify(h.swept)}`
      );
      process.exit(ok ? 0 : 1);
    }
    if (Date.now() > deadline) {
      console.error(`✗ not settled in time: openBets=${u.openBets}`);
      process.exit(1);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
