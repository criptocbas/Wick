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
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  DAEMON_PORT,
  EXPO,
  MARKETS,
  makeCtx,
  pdas,
  sendER,
  symbolBytes,
  toRaw,
  type MarketDef,
} from "./common";

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

let flashCache: Record<string, number> = {};
let flashOk = false;

async function pollFlash(): Promise<void> {
  try {
    const res = await fetch(`${FLASH_API}/v2/prices`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const body: any = await res.json();
    const list: any[] = Array.isArray(body) ? body : body.prices ?? body.data ?? [];
    const next: Record<string, number> = {};
    for (const entry of list) {
      const sym = String(entry.symbol ?? entry.token ?? "").toUpperCase();
      const m = MARKETS.find((mk) => mk.flashSymbol === sym);
      if (!m) continue;
      const raw = entry.price ?? entry.midPrice ?? entry.p;
      const price =
        typeof raw === "object" && raw
          ? Number(raw.price ?? raw.value) * 10 ** Number(raw.exponent ?? raw.expo ?? 0)
          : Number(raw);
      if (isFinite(price) && price > 0) next[m.symbol] = price;
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

function currentPrice(m: MarketDef): number {
  if (SOURCE === "flash" && flashOk && flashCache[m.symbol]) {
    // keep the walk anchored so a fallback is seamless
    walk[m.symbol] = flashCache[m.symbol];
    return flashCache[m.symbol];
  }
  return syntheticPrice(m);
}

// ── pusher loop: one ER tx per tick with every feed update ────

let pushing = false;
let pushCount = 0;

async function pushTick(): Promise<void> {
  if (pushing) return;
  pushing = true;
  try {
    const now = new BN(Date.now());
    const tx = new Transaction();
    for (const m of MARKETS) {
      tx.add(
        await ctx.program.methods
          .pushPrice(symbolBytes(m.symbol), toRaw(currentPrice(m)), EXPO, now)
          .accounts({ authority: ctx.admin.publicKey, feed: P.feed(m.symbol) })
          .instruction()
      );
    }
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

  const sig = await ctx.base.requestAirdrop(pk, FAUCET_SOL);
  await ctx.base.confirmTransaction(sig, "confirmed").catch(() => {});

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
