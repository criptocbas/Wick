/**
 * The Wick daemon: price pusher + faucet.
 *
 *  - Pushes prices into the delegated WickFeed accounts on the ER every ~250ms
 *    (gasless — this is a free real-time oracle, courtesy of the rollup).
 *    PRICE_SOURCE=flash pulls real prices from Flash Trade's public V2 API;
 *    PRICE_SOURCE=synthetic (default) runs a seeded random walk per market.
 *  - Serves a faucet for burner wallets: POST /faucet {wallet} → SOL + 1,000 wUSDC.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
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

/** The hedger's PUBLIC key (for the /desk panel) — never the secret. From
 *  HEDGER_PUBKEY, else derived read-only from the hedger keypair file if present. */
const HEDGER_PUBKEY: string | null = (() => {
  if (process.env.HEDGER_PUBKEY) return process.env.HEDGER_PUBKEY;
  const p =
    process.env.HEDGER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/wick-hedger.json");
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))))
      .publicKey.toBase58();
  } catch {
    return null;
  }
})();

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
interface FlashTick {
  price: number;
  tsMs: number;
  session: string; // "regular" | "preMarket" | "postMarket" | "overNight" | "closed" | ...
}
let flashCache: Record<string, FlashTick> = {};
let flashOk = false;

/** Sessions in which a market is actively trading (fresh prints). */
const TRADING_SESSIONS = new Set([
  "regular",
  "premarket",
  "postmarket",
  "overnight",
  "extended",
  "open",
]);

export function isTrading(session: string | undefined): boolean {
  return session ? TRADING_SESSIONS.has(session.toLowerCase()) : true;
}

async function pollFlash(): Promise<void> {
  try {
    const res = await fetch(`${FLASH_API}/v2/prices`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const body: any = await res.json();
    const next: Record<string, FlashTick> = {};
    for (const [sym, v] of Object.entries<any>(body)) {
      const m = MARKETS.find((mk) => mk.flashSymbol === sym.toUpperCase());
      if (!m) continue;
      const price = Number(v.priceUi);
      const tsMs = Math.floor(Number(v.timestampUs) / 1000);
      const session = String(v.marketSession ?? "regular");
      if (isFinite(price) && price > 0 && isFinite(tsMs)) next[m.symbol] = { price, tsMs, session };
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

/** Real Flash print (with its true timestamp + session — closed markets go stale,
 *  by design) or a synthetic walk stamped now (always "regular"). */
function currentPrice(m: MarketDef): { price: number; tsMs: number; session: string } {
  const f = SOURCE === "flash" && flashOk ? flashCache[m.symbol] : undefined;
  if (f) {
    walk[m.symbol] = f.price; // keep the walk anchored for seamless fallback
    return f;
  }
  return { price: syntheticPrice(m), tsMs: Date.now(), session: "regular" };
}

// ── pusher loop: one ER tx per fresh print ────────────────────

let pushing = false;
let pushCount = 0;
/** Last on-chain ts pushed per market — closed/unchanged markets are skipped so
 *  their on-chain feed naturally freezes (the frontend reads that as "closed"). */
const lastPushedTs: Record<string, number> = {};

async function pushTick(): Promise<void> {
  if (pushing) return;
  pushing = true;
  try {
    const tx = new Transaction();
    for (const m of PUSHED) {
      const { price, tsMs, session } = currentPrice(m);
      // skip markets that aren't trading, or whose print hasn't advanced
      if (!isTrading(session)) continue;
      if ((lastPushedTs[m.symbol] ?? 0) >= tsMs) continue;
      lastPushedTs[m.symbol] = tsMs;
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

// ── read surfaces for the frontend ────────────────────────────

/** Optional test hook: comma-separated symbols to report as closed. */
const FORCE_CLOSED = new Set(
  (process.env.FORCE_CLOSED ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);

/** Per-market trading session for the markets the daemon sources from Flash. */
function marketsStatus() {
  return MARKETS.map((m) => {
    const f = flashCache[m.symbol];
    let session = f?.session ?? "regular";
    if (FORCE_CLOSED.has(m.symbol)) session = "closed";
    return {
      symbol: m.symbol,
      session,
      trading: isTrading(session),
      tsMs: f?.tsMs ?? null,
    };
  });
}

/** The house risk desk: net user exposure per market (from the ER books) plus
 *  the real offsetting positions the hedger holds on Flash Trade mainnet. */
async function deskState() {
  // 1) net user exposure per market from the delegated ER books
  const books = await ctx.er
    .getMultipleAccountsInfo(MARKETS.map((m) => P.book(m.idx)))
    .catch(() => [] as (null | { data: Buffer })[]);
  const exposure = MARKETS.map((m, i) => {
    const info = books[i];
    let longUsd = 0;
    let shortUsd = 0;
    if (info) {
      const b: any = ctx.program.coder.accounts.decode("marketBook", info.data as Buffer);
      longUsd = b.longOpen.toNumber() / 1e6;
      shortUsd = b.shortOpen.toNumber() / 1e6;
    }
    return { symbol: m.symbol, longUsd, shortUsd, netUsd: longUsd - shortUsd };
  });

  // 2) the hedger's real Flash V1 positions (public read by pubkey)
  let positions: any[] = [];
  if (HEDGER_PUBKEY) {
    try {
      const r = await fetch(
        `${FLASH_API}/positions/owner/${HEDGER_PUBKEY}?includePnlInLeverageDisplay=true`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (r.ok) {
        const raw: any = await r.json();
        const list: any[] = Array.isArray(raw) ? raw : raw.positions ?? [];
        positions = list
          .map((p) => ({
            market: String(p.marketSymbol ?? "").toUpperCase(),
            side: String(p.sideUi ?? p.side ?? "").toUpperCase().startsWith("S") ? "SHORT" : "LONG",
            sizeUsd: Number(p.sizeUsdUi ?? p.sizeUsd ?? 0),
            entryUi: p.entryPriceUi ?? null,
            pnlUsd: p.pnlWithFeeUsdUi ?? null,
            key: p.key ?? null,
          }))
          .filter((p) => p.market && p.sizeUsd > 0);
      }
    } catch {
      /* hedger may be flat or offline */
    }
  }

  return { hedger: HEDGER_PUBKEY, exposure, positions };
}

/** Top players by streak/PnL, read from on-chain UserAccounts. */
let lbCache: { at: number; rows: any[] } = { at: 0, rows: [] };
async function leaderboard() {
  // cache for 5s — getProgramAccounts is heavy on public RPC
  if (Date.now() - lbCache.at < 5000) return lbCache.rows;
  const all: any[] = await (ctx.program.account as any).userAccount.all();
  const rows = all
    .map((a) => {
      const u = a.account;
      return {
        wallet: u.authority.toBase58(),
        wins: u.wins,
        losses: u.losses,
        pushes: u.pushes,
        streak: u.streak,
        bestStreak: u.bestStreak,
        pnlUsd: u.pnl.toNumber() / 1e6,
        volumeUsd: u.totalWagered.toNumber() / 1e6,
      };
    })
    .filter((r) => r.wins + r.losses > 0)
    .sort((a, b) => b.bestStreak - a.bestStreak || b.pnlUsd - a.pnlUsd)
    .slice(0, 20);
  lbCache = { at: Date.now(), rows };
  return rows;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const json = (code: number, body: unknown) =>
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  if (req.method === "GET" && req.url === "/health") {
    return json(200, { ok: true, source: SOURCE, flash: flashOk, pushes: pushCount });
  }

  if (req.method === "GET" && req.url === "/markets") {
    return json(200, marketsStatus());
  }

  if (req.method === "GET" && req.url === "/desk") {
    try {
      return json(200, await deskState());
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : "desk read failed" });
    }
  }

  if (req.method === "GET" && req.url === "/leaderboard") {
    try {
      return json(200, await leaderboard());
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : "leaderboard read failed" });
    }
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
