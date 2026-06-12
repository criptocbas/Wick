/**
 * The Wick daemon: price pusher + settlement sweeper + faucet.
 *
 *  - Pushes prices into the delegated WickFeed accounts on the ER every ~250ms
 *    (gasless — this is a free real-time oracle, courtesy of the rollup).
 *    PRICE_SOURCE=flash pulls real prices from Flash Trade's public V2 API;
 *    PRICE_SOURCE=synthetic (default) runs a seeded random walk per market.
 *  - Sweeps EVERY user's open bets: resolves them the moment a qualifying
 *    print lands in the settlement window, voids them (stake refund) if the
 *    window closes unfilled. Both instructions are permissionless, so this is
 *    a liveness guarantee, not a privilege — anyone can run the same sweep.
 *  - Serves a faucet for burner wallets: POST /faucet {wallet} → SOL + 1,000 wUSDC.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import BN from "bn.js";
import bs58 from "bs58";
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
  loadIdl,
  makeCtx,
  pdas,
  pythFeedPda,
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

// ── settlement sweeper ────────────────────────────────────────
// The on-chain rule is strict: a bet settles only against a print inside
// [expiry, expiry + grace], else it must be voided. The browser auto-resolves
// its own bets, the crank fires where the ER supports it — and this sweep is
// the house-run backstop that makes settlement independent of both.

const SWEEP_MS = Number(process.env.SWEEP_MS ?? 400);
/** Mirrors the program's VOID_DELAY_MS (state.rs). */
const VOID_DELAY_MS = 2_000;

const USER_DISCRIMINATOR: number[] = (() => {
  const acc = loadIdl().accounts.find((a: any) => a.name === "UserAccount");
  if (!acc?.discriminator) throw new Error("UserAccount discriminator missing from IDL");
  return acc.discriminator;
})();
const userFilter = [
  { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(USER_DISCRIMINATOR)) } },
];

/** resolve_grace_ms from on-chain config (refreshed in the background). */
let graceMs = 3_000;
async function refreshConfig(): Promise<void> {
  try {
    const cfg: any = await (ctx.program.account as any).config.fetch(P.config);
    graceMs = cfg.resolveGraceMs;
  } catch {
    /* keep the last known value */
  }
}

function feedPdaOf(m: MarketDef): PublicKey {
  return usesPythOracle(m) ? pythFeedPda(m.pythId!) : P.feed(m.symbol);
}

/** Latest print (raw price + ts) from a raw feed account. Price/expo share the
 *  feed's units, so a bet placed against the same feed can compare raw values. */
function feedReadOf(m: MarketDef, data: Buffer): { price: number; tsMs: number } {
  if (usesPythOracle(m)) {
    return {
      price: Number(data.readBigInt64LE(73)), // price i64 @73
      tsMs: Number(data.readBigInt64LE(93)) * 1000, // publish_time (s) @93
    };
  }
  // WickFeed: 8 disc + 12 symbol, then price i64, expo i32, ts_ms i64
  return {
    price: Number(data.readBigInt64LE(8 + 12)),
    tsMs: Number(data.readBigInt64LE(8 + 12 + 8 + 4)),
  };
}

const BET_KIND_TOUCH = 1;
const sweepCooldown = new Map<string, number>();
const sweepStats = { resolved: 0, voided: 0, touched: 0 };
let sweeping = false;

async function sweepTick(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const feedInfos = await ctx.er.getMultipleAccountsInfo(MARKETS.map(feedPdaOf));
    const feed: Record<number, { price: number; tsMs: number }> = {};
    MARKETS.forEach((m, i) => {
      const info = feedInfos[i];
      if (info) feed[m.idx] = feedReadOf(m, info.data as Buffer);
    });

    const users = await ctx.er.getProgramAccounts(ctx.programId, { filters: userFilter });
    const now = Date.now();
    for (const { pubkey, account } of users) {
      let u: any;
      try {
        u = ctx.program.coder.accounts.decode("userAccount", account.data as Buffer);
      } catch {
        continue;
      }
      if (u.openBets === 0) continue;
      (u.bets as any[]).forEach((b, slot) => {
        if (b.status !== 1) return;
        const m = MARKETS.find((mk) => mk.idx === b.marketIdx);
        const f = m ? feed[m.idx] : undefined;
        if (!m || !f) return;
        const ts = f.tsMs;
        const placed = (b.placedMs as BN).toNumber();
        const expiry = (b.expiryMs as BN).toNumber();
        const windowEnd = expiry + graceMs;
        const key = `${pubkey.toBase58()}:${slot}:${placed}`;
        if ((sweepCooldown.get(key) ?? 0) > now) return;

        // For a TOUCH bet, the live job is to detect a barrier crossing on any
        // in-window print — the continuous monitoring an ER makes free.
        let action: "resolve" | "void" | "checkTouch" | null = null;
        if (b.kind === BET_KIND_TOUCH) {
          const barrier = (b.strike as BN).toNumber();
          const inWindow = ts > placed && ts <= expiry;
          const crossed = b.direction === 1 ? f.price >= barrier : f.price <= barrier;
          if (inWindow && crossed) action = "checkTouch";
          else if (ts >= expiry && ts <= windowEnd) action = "resolve"; // untouched → loss
          else if (now > windowEnd + VOID_DELAY_MS + 500 && (ts < expiry || ts > windowEnd))
            action = "void";
        } else {
          if (ts >= expiry && ts <= windowEnd) action = "resolve";
          else if (now > windowEnd + VOID_DELAY_MS + 500 && (ts < expiry || ts > windowEnd))
            action = "void";
        }
        if (!action) return;

        // Touch checks can fire many times per window; don't rate-limit a
        // crossing as hard as a one-shot resolve/void.
        sweepCooldown.set(key, now + (action === "checkTouch" ? 700 : 2_500));
        const method =
          action === "checkTouch"
            ? ctx.program.methods.checkTouch(slot)
            : action === "resolve"
              ? ctx.program.methods.resolveBet(slot)
              : ctx.program.methods.voidBet(slot);
        void method
          .accounts({
            resolver: ctx.admin.publicKey,
            market: P.market(m.idx),
            book: P.book(m.idx),
            house: P.house,
            userAccount: pubkey,
            feed: feedPdaOf(m),
          })
          .instruction()
          .then((ix) => sendER(ctx, new Transaction().add(ix)))
          .then(() => {
            sweepStats[
              action === "checkTouch" ? "touched" : action === "resolve" ? "resolved" : "voided"
            ]++;
          })
          .catch(() => {
            /* lost the race to the user's own resolver, or not actually crossed — fine */
          });
      });
    }
    if (sweepCooldown.size > 5_000) {
      for (const [k, until] of sweepCooldown) if (until < now) sweepCooldown.delete(k);
    }
  } catch (e) {
    console.warn("sweep failed:", e instanceof Error ? e.message.slice(0, 120) : e);
  } finally {
    sweeping = false;
  }
}

// ── faucet ────────────────────────────────────────────────────

const FAUCET_DISABLED = process.env.FAUCET_DISABLED === "1";
/** The faucet spends the admin key's SOL, so the binding limit is a GLOBAL
 *  hourly cap on how many grants it will make — fresh keypairs and spoofed IPs
 *  can't get past it. Per-wallet + per-IP windows are friction on top. We trust
 *  X-Forwarded-For only behind a known proxy (TRUST_PROXY=1); otherwise the
 *  socket address is authoritative so the header can't be spoofed to rotate IPs. */
const FAUCET_WALLET_COOLDOWN_MS = Number(process.env.FAUCET_WALLET_COOLDOWN_MS ?? 10 * 60_000);
const FAUCET_IP_MAX_PER_HOUR = Number(process.env.FAUCET_IP_MAX_PER_HOUR ?? 6);
const FAUCET_GLOBAL_MAX_PER_HOUR = Number(process.env.FAUCET_GLOBAL_MAX_PER_HOUR ?? 40);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const faucetWalletAt = new Map<string, number>();
const faucetIpWindow = new Map<string, { n: number; t0: number }>();
let faucetGlobal: number[] = []; // grant timestamps in the last hour

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY && typeof req.headers["x-forwarded-for"] === "string") {
    return req.headers["x-forwarded-for"].split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "?";
}

/** Decide before spending; pass `commit` once the grant actually happens so a
 *  rejected/failed faucet doesn't consume the caller's quota. */
function faucetGate(wallet: string, ip: string): { denied: string | null; commit: () => void } {
  const deny = (m: string) => ({ denied: m, commit: () => {} });
  if (FAUCET_DISABLED) return deny("faucet disabled");
  const now = Date.now();
  faucetGlobal = faucetGlobal.filter((t) => now - t < 60 * 60_000);
  if (faucetGlobal.length >= FAUCET_GLOBAL_MAX_PER_HOUR) return deny("faucet busy — try later");
  if (now - (faucetWalletAt.get(wallet) ?? 0) < FAUCET_WALLET_COOLDOWN_MS)
    return deny("wallet already funded — try later");
  const w = faucetIpWindow.get(ip);
  if (w && now - w.t0 < 60 * 60_000 && w.n >= FAUCET_IP_MAX_PER_HOUR)
    return deny("rate limit — try later");
  return {
    denied: null,
    commit: () => {
      faucetWalletAt.set(wallet, now);
      faucetGlobal.push(now);
      const cur = faucetIpWindow.get(ip);
      if (cur && now - cur.t0 < 60 * 60_000) cur.n++;
      else faucetIpWindow.set(ip, { n: 1, t0: now });
    },
  };
}

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
let deskCache: { at: number; value: any } = { at: 0, value: null };
async function deskStateCached() {
  if (deskCache.value && Date.now() - deskCache.at < 2_500) return deskCache.value;
  const value = await deskState();
  deskCache = { at: Date.now(), value };
  return value;
}

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

  // 3) the house ledger from the delegated ER account — lifetime_pnl is the
  //    edge accumulating; locked is the live solvency reserve.
  let house: { balanceUsd: number; lockedUsd: number; lifetimePnlUsd: number } | null = null;
  try {
    const info = await ctx.er.getAccountInfo(P.house);
    if (info) {
      const h: any = ctx.program.coder.accounts.decode("house", info.data as Buffer);
      house = {
        balanceUsd: h.balance.toNumber() / 1e6,
        lockedUsd: h.locked.toNumber() / 1e6,
        lifetimePnlUsd: h.lifetimePnl.toNumber() / 1e6,
      };
    }
  } catch {
    /* house may be briefly unreadable */
  }

  // 4) the hedge's live unrealized P&L (sum of real Flash position P&L)
  const hedgePnlUsd = positions.reduce((s, p) => s + (Number(p.pnlUsd) || 0), 0);

  return { hedger: HEDGER_PUBKEY, house, hedgePnlUsd, exposure, positions };
}

/** Top players by streak/PnL, read from on-chain UserAccounts. Delegated
 *  accounts are owned by the Delegation Program on L1 and invisible to a
 *  plain program scan there — so merge L1 (settled) with the ER (live),
 *  letting the live session state win. */
let lbCache: { at: number; rows: any[] } = { at: 0, rows: [] };
async function leaderboard() {
  // cache for 5s — getProgramAccounts is heavy on public RPC
  if (Date.now() - lbCache.at < 5000) return lbCache.rows;
  const [l1, er] = await Promise.all([
    (ctx.program.account as any).userAccount.all().catch(() => [] as any[]),
    ctx.er
      .getProgramAccounts(ctx.programId, { filters: userFilter })
      .then((list) =>
        list
          .map(({ account }) => {
            try {
              return ctx.program.coder.accounts.decode("userAccount", account.data as Buffer);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      )
      .catch(() => [] as any[]),
  ]);
  const byWallet = new Map<string, any>();
  for (const a of l1) byWallet.set(a.account.authority.toBase58(), a.account);
  for (const u of er) byWallet.set(u.authority.toBase58(), u);
  const rows = [...byWallet.values()]
    .map((u) => {
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
    return json(200, {
      ok: true,
      source: SOURCE,
      flash: flashOk,
      pushes: pushCount,
      swept: sweepStats,
    });
  }

  if (req.method === "GET" && req.url === "/markets") {
    return json(200, marketsStatus());
  }

  if (req.method === "GET" && req.url === "/desk") {
    try {
      return json(200, await deskStateCached());
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
        new PublicKey(wallet); // validate before touching any limit state
        const { denied, commit } = faucetGate(wallet, clientIp(req));
        if (denied) return void res.writeHead(429).end(denied);
        const out = await faucet(wallet);
        commit(); // only consume quota once the grant actually landed
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

// A long-running keeper must outlive a bad RPC response or one rejected
// promise — log loudly, keep pushing prices and sweeping settlements.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// A failure to bind the port is fatal — exit loudly rather than run a
// half-alive daemon that pushes prices but serves nothing (the global
// uncaughtException handler below would otherwise swallow it).
server.on("error", (e) => {
  console.error("daemon http server error:", e);
  process.exit(1);
});
server.listen(DAEMON_PORT, () => {
  console.log(
    `wick daemon on :${DAEMON_PORT} — source=${SOURCE}, tick=${TICK_MS}ms, sweep=${SWEEP_MS}ms`
  );
});

setInterval(pushTick, TICK_MS);
setInterval(sweepTick, SWEEP_MS);
void refreshConfig();
setInterval(refreshConfig, 60_000);
if (SOURCE === "flash") {
  void pollFlash();
  setInterval(pollFlash, 1000);
}
