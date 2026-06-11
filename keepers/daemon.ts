/**
 * The Wick daemon: price pusher + faucet.
 *
 *  - Pushes prices into the delegated WickFeed accounts on the ER every ~250ms
 *    (gasless — this is a free real-time oracle, courtesy of the rollup).
 *    PRICE_SOURCE=flash pulls real prices from Flash Trade's public V2 API;
 *    PRICE_SOURCE=synthetic (default) runs a seeded random walk per market.
 *  - Serves a faucet for burner wallets: POST /faucet {wallet} → SOL + 1,000 wUSDC.
 */
import http from "node:http";
import BN from "bn.js";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  CLUSTER,
  DAEMON_PORT,
  EXPO,
  MARKETS,
  makeCtx,
  pdas,
  sendER,
  symbolBytes,
  toRaw,
  usesPythOracle,
  type MarketDef,
} from "./common";

/** Markets the daemon is responsible for (MagicBlock-oracle markets push themselves). */
const PUSHED = MARKETS.filter((m) => !usesPythOracle(m));

const SOURCE = process.env.PRICE_SOURCE ?? "synthetic";
const TICK_MS = Number(process.env.TICK_MS ?? 250);
const FLASH_API = process.env.FLASH_API ?? "https://flashapi.trade";
const FAUCET_TOKENS = 1_000_000_000; // 1,000 wUSDC
const FAUCET_SOL = 500_000_000; // 0.5 SOL

const ctx = makeCtx();
const P = pdas(ctx.programId);

// ── price sources ─────────────────────────────────────────────

const walk: Record<string, number> = {};
for (const m of MARKETS) walk[m.symbol] = m.base;

function syntheticPrice(m: MarketDef): number {
  const p = walk[m.symbol];
  const drift = p * m.vol * (Math.random() * 2 - 1) * 3;
  // soft mean reversion keeps the walk near base
  const pull = (m.base - p) * 0.0008;
  walk[m.symbol] = Math.max(p + drift + pull, m.base * 0.5);
  return walk[m.symbol];
}

/** /v2/prices returns an object keyed by symbol:
 *  { "SOL": { price, exponent, priceUi, timestampUs, marketSession }, ... } */
let flashCache: Record<string, { price: number; tsMs: number }> = {};
let flashOk = false;

async function pollFlash(): Promise<void> {
  try {
    const res = await fetch(`${FLASH_API}/v2/prices`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const body: any = await res.json();
    const next: Record<string, { price: number; tsMs: number }> = {};
    for (const [sym, v] of Object.entries<any>(body)) {
      const m = MARKETS.find((mk) => mk.flashSymbol === sym.toUpperCase());
      if (!m) continue;
      const price = Number(v.priceUi);
      const tsMs = Math.floor(Number(v.timestampUs) / 1000);
      if (isFinite(price) && price > 0 && isFinite(tsMs)) next[m.symbol] = { price, tsMs };
    }
    if (Object.keys(next).length > 0) {
      flashCache = next;
      if (!flashOk) console.log(`flash prices live: ${Object.keys(next).join(", ")}`);
      flashOk = true;
    }
  } catch (e) {
    if (flashOk) console.warn("flash poll failed, falling back to synthetic");
    flashOk = false;
  }
}

/** Real Flash print (with its true timestamp — closed markets go stale, by design)
 *  or a synthetic walk stamped now. */
function currentPrice(m: MarketDef): { price: number; tsMs: number } {
  const f = SOURCE === "flash" && flashOk ? flashCache[m.symbol] : undefined;
  if (f) {
    walk[m.symbol] = f.price; // keep the walk anchored for seamless fallback
    return f;
  }
  return { price: syntheticPrice(m), tsMs: Date.now() };
}

// ── pusher loop: one ER tx per tick with every feed update ────

let pushing = false;
let pushCount = 0;

async function pushTick(): Promise<void> {
  if (pushing) return;
  pushing = true;
  try {
    const tx = new Transaction();
    const lastTs: Record<string, number> = {};
    for (const m of PUSHED) {
      const { price, tsMs } = currentPrice(m);
      if (lastTs[m.symbol] === tsMs) continue; // no new print
      lastTs[m.symbol] = tsMs;
      tx.add(
        await ctx.program.methods
          .pushPrice(symbolBytes(m.symbol), toRaw(price), EXPO, new BN(tsMs))
          .accounts({ authority: ctx.admin.publicKey, feed: P.feed(m.symbol) })
          .instruction()
      );
    }
    if (tx.instructions.length === 0) return;
    await sendER(ctx, tx);
    if (++pushCount % 240 === 0)
      console.log(`pushed ${pushCount} ticks (${SOURCE}${flashOk ? "+flash" : ""})`);
  } catch (e) {
    console.warn("push failed:", e instanceof Error ? e.message.slice(0, 120) : e);
  } finally {
    pushing = false;
  }
}

// ── faucet ────────────────────────────────────────────────────

async function faucet(wallet: string): Promise<{ sol: boolean; tokens: boolean }> {
  const pk = new PublicKey(wallet);
  const mintPk = await (async () => {
    const cfg: any = await (ctx.program.account as any).config.fetch(P.config);
    return cfg.mint as PublicKey;
  })();

  const sol = CLUSTER === "localnet" ? FAUCET_SOL : 30_000_000; // devnet: 0.03 SOL from admin
  if (CLUSTER === "localnet") {
    const sig = await ctx.base.requestAirdrop(pk, sol);
    await ctx.base.confirmTransaction(sig, "confirmed").catch(() => {});
  } else {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: ctx.admin.publicKey, toPubkey: pk, lamports: sol })
    );
    await sendAndConfirmTransaction(ctx.base, tx, [ctx.admin], { commitment: "confirmed" });
  }

  const ata = await getOrCreateAssociatedTokenAccount(ctx.base, ctx.admin, mintPk, pk);
  await mintTo(ctx.base, ctx.admin, mintPk, ata.address, ctx.admin, FAUCET_TOKENS);
  return { sol: true, tokens: true };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.method === "GET" && req.url === "/health") {
    return res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: true, source: SOURCE, flash: flashOk, pushes: pushCount }));
  }

  if (req.method === "POST" && req.url === "/faucet") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { wallet } = JSON.parse(body);
        const out = await faucet(wallet);
        console.log(`faucet → ${wallet}`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        console.warn("faucet failed:", e);
        res.writeHead(500).end(e instanceof Error ? e.message : "faucet failed");
      }
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(DAEMON_PORT, () => {
  console.log(`wick daemon on :${DAEMON_PORT} — source=${SOURCE}, tick=${TICK_MS}ms`);
});

setInterval(pushTick, TICK_MS);
if (SOURCE === "flash") {
  void pollFlash();
  setInterval(pollFlash, 1000);
}
