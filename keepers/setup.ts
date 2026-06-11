/**
 * One-shot protocol setup: mint, markets, feeds, house liquidity, ER delegation.
 * Idempotent — safe to re-run. Writes app/public/chain-config.json when done.
 *
 *   npm run setup            # against localnet (validators must be running)
 *   CLUSTER=devnet BASE_RPC=... ER_RPC=... npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  CLUSTER,
  BASE_RPC,
  BASE_WS,
  ER_RPC,
  ER_WS,
  DAEMON_PORT,
  EXPO,
  MARKETS,
  VALIDATOR,
  makeCtx,
  pdas,
  symbolBytes,
  toRaw,
} from "./common";

const FEED_KIND_WICK = 1;
const HOUSE_LIQUIDITY = 100_000_000_000; // 100k wUSDC
const ADMIN_MINT = 1_000_000_000_000; // 1M wUSDC

const ctx = makeCtx();
const P = pdas(ctx.programId);
const validator = { pubkey: new PublicKey(VALIDATOR), isSigner: false, isWritable: false };

async function exists(pk: PublicKey): Promise<boolean> {
  return !!(await ctx.base.getAccountInfo(pk));
}

async function delegated(pk: PublicKey): Promise<boolean> {
  const info = await ctx.base.getAccountInfo(pk);
  return (
    !!info && info.owner.toBase58() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
  );
}

async function main() {
  console.log(`setup → cluster=${CLUSTER} admin=${ctx.admin.publicKey.toBase58()}`);

  // 1) mint
  let mint: PublicKey;
  if (await exists(P.config)) {
    const cfg: any = await (ctx.program.account as any).config.fetch(P.config);
    mint = cfg.mint;
    console.log(`config exists — reusing mint ${mint.toBase58()}`);
  } else {
    mint = await createMint(ctx.base, ctx.admin, ctx.admin.publicKey, null, 6);
    console.log(`mint created ${mint.toBase58()}`);
    await ctx.program.methods
      .initialize(ctx.admin.publicKey)
      .accounts({ admin: ctx.admin.publicKey, mint })
      .rpc();
    console.log("protocol initialized");
  }

  // 2) admin liquidity
  const adminAta = await getOrCreateAssociatedTokenAccount(
    ctx.base,
    ctx.admin,
    mint,
    ctx.admin.publicKey
  );
  if (Number(adminAta.amount) < ADMIN_MINT / 2) {
    await mintTo(ctx.base, ctx.admin, mint, adminAta.address, ctx.admin, ADMIN_MINT);
    console.log("admin wUSDC minted");
  }

  // 3) feeds + markets
  const cfgAcc: any = await (ctx.program.account as any).config.fetch(P.config);
  for (const m of MARKETS) {
    const feedPda = P.feed(m.symbol);
    if (!(await exists(feedPda)) && !(await delegated(feedPda))) {
      await ctx.program.methods
        .createFeed(symbolBytes(m.symbol))
        .accounts({ admin: ctx.admin.publicKey, feed: feedPda })
        .rpc();
      await ctx.program.methods
        .pushPrice(symbolBytes(m.symbol), toRaw(m.base), EXPO, new BN(Date.now()))
        .accounts({ authority: ctx.admin.publicKey, feed: feedPda })
        .rpc();
      console.log(`feed ${m.symbol} created + seeded`);
    }
    if (m.idx < cfgAcc.numMarkets) continue;
    await ctx.program.methods
      .createMarket(m.idx, symbolBytes(m.symbol), FEED_KIND_WICK, feedPda)
      .accounts({
        admin: ctx.admin.publicKey,
        market: P.market(m.idx),
        book: P.book(m.idx),
      })
      .rpc();
    cfgAcc.numMarkets++;
    console.log(`market ${m.idx} ${m.symbol} created`);
  }

  // 4) house liquidity
  const house: any = await (ctx.program.account as any).house.fetch(P.house).catch(() => null);
  if (house && house.balance.toNumber() === 0 && !(await delegated(P.house))) {
    await ctx.program.methods
      .fundHouse(new BN(HOUSE_LIQUIDITY))
      .accounts({ admin: ctx.admin.publicKey, from: adminAta.address })
      .rpc();
    console.log("house funded with 100k");
  }

  // 5) delegate ops accounts into the ER
  if (!(await delegated(P.house))) {
    await ctx.program.methods
      .delegateHouse()
      .accounts({ payer: ctx.admin.publicKey, house: P.house })
      .remainingAccounts([validator])
      .rpc({ skipPreflight: true });
    console.log("house delegated");
  }
  for (const m of MARKETS) {
    if (!(await delegated(P.book(m.idx)))) {
      await ctx.program.methods
        .delegateBook(m.idx)
        .accounts({ payer: ctx.admin.publicKey, book: P.book(m.idx) })
        .remainingAccounts([validator])
        .rpc({ skipPreflight: true });
    }
    if (!(await delegated(P.feed(m.symbol)))) {
      await ctx.program.methods
        .delegateFeed(symbolBytes(m.symbol))
        .accounts({ payer: ctx.admin.publicKey, feed: P.feed(m.symbol) })
        .remainingAccounts([validator])
        .rpc({ skipPreflight: true });
    }
  }
  console.log("books + feeds delegated");

  // 6) app config
  const appCfg = {
    cluster: CLUSTER,
    baseRpc: BASE_RPC,
    baseWs: BASE_WS,
    erRpc: ER_RPC,
    erWs: ER_WS,
    daemon: `http://localhost:${DAEMON_PORT}`,
    mint: mint.toBase58(),
    validator: VALIDATOR,
    markets: MARKETS.map((m) => ({
      idx: m.idx,
      symbol: m.symbol,
      kind: FEED_KIND_WICK,
      feed: P.feed(m.symbol).toBase58(),
      display: m.display,
    })),
  };
  const out = path.join(import.meta.dirname, "../app/public/chain-config.json");
  fs.writeFileSync(out, JSON.stringify(appCfg, null, 2));
  console.log(`wrote ${out}\nsetup complete ✓`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
