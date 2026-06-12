/**
 * End-to-end settlement-liveness check: onboard a fresh burner, place a bet,
 * and deliberately NEVER resolve it from this client. The daemon's sweeper
 * must settle it (resolve in-window, or void after) — proving settlement does
 * not depend on the bettor's browser staying open.
 *
 *   CLUSTER=localnet npx tsx test-sweep.ts     (daemon must be running)
 *   CLUSTER=devnet  npx tsx test-sweep.ts
 */
import BN from "bn.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  CLUSTER,
  DAEMON_PORT,
  MARKETS,
  VALIDATOR,
  loadIdl,
  makeCtx,
  pdas,
  usesPythOracle,
} from "./common";

const DAEMON = process.env.DAEMON_URL ?? `http://localhost:${DAEMON_PORT}`;
const MARKET = MARKETS.find((m) => m.symbol === (process.env.SWEEP_MARKET ?? "SOL"))!;
const DURATION_S = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = makeCtx();
  const P = pdas(ctx.programId);
  const burner = Keypair.generate();
  console.log(`burner ${burner.publicKey.toBase58()} on ${CLUSTER}`);

  // fund via the daemon faucet (also exercises the rate limiter happy path)
  const fr = await fetch(`${DAEMON}/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: burner.publicKey.toBase58() }),
  });
  if (!fr.ok) throw new Error(`faucet: ${fr.status} ${await fr.text()}`);
  console.log("faucet ok");

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

  // wait for tokens to land, then init + deposit + delegate on L1
  for (let i = 0; i < 30; i++) {
    const bal = await ctx.base.getTokenAccountBalance(ata).catch(() => null);
    if (bal?.value.uiAmount) break;
    await sleep(800);
  }
  await (program.methods as any)
    .initUser(burner.publicKey)
    .accounts({ authority: burner.publicKey })
    .rpc();
  await (program.methods as any)
    .deposit(new BN(100_000_000))
    .accounts({ authority: burner.publicKey, from: ata })
    .rpc();
  await (program.methods as any)
    .delegateUser()
    .accounts({ payer: burner.publicKey, userAccount: userPda })
    .remainingAccounts([
      { pubkey: new PublicKey(VALIDATOR), isSigner: false, isWritable: false },
    ])
    .rpc({ skipPreflight: true });
  console.log("user funded, deposited 100, delegated");

  // wait for the delegation to land on the ER
  for (let i = 0; i < 40; i++) {
    if (await ctx.er.getAccountInfo(userPda).catch(() => null)) break;
    await sleep(500);
  }

  const feedPda = usesPythOracle(MARKET)
    ? new PublicKey(
        (await import("./common")).pythFeedPda(MARKET.pythId!)
      )
    : P.feed(MARKET.symbol);

  // place on the ER (re-sign with ER blockhash; retry the delegation race)
  const placeIx = await (program.methods as any)
    .placeBet(1, new BN(10_000_000), DURATION_S)
    .accounts({
      operator: burner.publicKey,
      market: P.market(MARKET.idx),
      book: P.book(MARKET.idx),
      house: P.house,
      userAccount: userPda,
      feed: feedPda,
    })
    .instruction();
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(placeIx);
      tx.feePayer = burner.publicKey;
      tx.recentBlockhash = (await ctx.er.getLatestBlockhash()).blockhash;
      tx.sign(burner);
      const sig = await ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      // poll status; the ER indexes failures slowly, so check the account too
      let landed = false;
      for (let i = 0; i < 50; i++) {
        const st = await ctx.er.getSignatureStatus(sig);
        if (st.value?.err) throw new Error(`place failed: ${JSON.stringify(st.value.err)}`);
        if (st.value?.confirmationStatus) {
          landed = true;
          break;
        }
        await sleep(100);
      }
      if (!landed) throw new Error("place confirm timeout");
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 5 && /InvalidWritableAccount|timeout|not.*delegat/i.test(msg)) {
        await sleep(1200);
        continue;
      }
      throw e;
    }
  }
  console.log(`bet placed (${MARKET.symbol}, ${DURATION_S}s) — NOT resolving from here`);

  // the daemon's sweeper must settle it: expiry(5s) + grace(3s) + margin
  const deadline = Date.now() + 25_000;
  for (;;) {
    await sleep(1_000);
    const info = await ctx.er.getAccountInfo(userPda);
    const u: any = program.coder.accounts.decode("userAccount", info!.data);
    const settled = u.wins + u.losses + u.pushes;
    if (u.openBets === 0 && settled === 1) {
      const outcome = u.wins ? "WIN" : u.losses ? "LOSS" : "PUSH/VOID";
      console.log(
        `✓ swept by the daemon: outcome=${outcome} balance=${u.balance.toNumber() / 1e6}`
      );
      const h = await fetch(`${DAEMON}/health`).then((r) => r.json());
      console.log(`daemon health:`, JSON.stringify(h));
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.error(`✗ NOT swept in 25s: openBets=${u.openBets} settled=${settled}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
