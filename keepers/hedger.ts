/**
 * The Flash Trade hedger — Wick's risk desk.
 *
 * Reads each market's open interest from the delegated books on the EPHEMERAL
 * ROLLUP, computes the house's net directional exposure, and offsets it with
 * real perp positions on FLASH TRADE MAINNET via the V2 transaction-builders.
 * Users net-long ⇒ the house is implicitly short ⇒ the desk goes LONG the same
 * notional on Flash (× HEDGE_RATIO), and vice versa.
 *
 * Modes
 *   npm run hedger                    poll + hedge (DRY_RUN=1 by default: log only)
 *   DRY_RUN=0 npm run hedger          ARMED — signs + sends real mainnet txs
 *   npm run hedger -- preview         one $11 SOL preview quote (no owner, no spend)
 *   npm run hedger -- flatten         close every open hedge position, reclaim rent
 *   npm run hedger -- reclaim         close empty token accounts, reclaim their rent
 *   npm run hedger -- recover [usd]   pull deposited collateral out of Flash V2 ($25)
 *
 * Guardrails (all enforced before any transaction is built)
 *   MAX_HEDGE_USD          hard cap on TOTAL absolute hedge notional   (default 30)
 *   MAX_MARKET_HEDGE_USD   hard cap per market                         (default 15)
 *   MIN_ADJUST_USD         hysteresis: ignore deltas smaller than this (default 12)
 *   COOLDOWN_MS            min time between adjustments per market     (default 20s)
 *   auto-flatten on SIGINT/SIGTERM when armed; periodic rent reclaim while armed
 *
 * env: HEDGER_KEYPAIR (default ~/.config/solana/wick-hedger.json), MAINNET_RPC,
 *      HEDGE_RATIO (0.9), LEVERAGE (2), POLL_MS (3000), FLASH_API.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { MARKETS, makeCtx, pdas } from "./common";

const MODE = (process.argv[2] ?? "hedge") as "hedge" | "preview" | "flatten" | "recover" | "reclaim";
const DRY_RUN = MODE === "hedge" ? process.env.DRY_RUN !== "0" : false;

const FLASH_API = process.env.FLASH_API ?? "https://flashapi.trade";
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ── Why Flash V1, not V2 ──────────────────────────────────────
// Flash V2 perps execute inside Flash's OWN private MagicBlock ephemeral rollup
// (basket delegated to node FLAshCJGr…); trade submission is IP-allowlisted to
// Flash's infra, so a third-party keeper cannot broadcast V2 trades. Flash V1
// (program FLASH6Lo…) is the original pool-to-peer model on *base mainnet* — no
// basket, no delegation, pay collateral straight into the position. We verified
// a V1 open-position simulates clean against public mainnet, so the hedge desk
// runs on V1. (This is itself a nice finding: Flash V2 = an ER app, just like Wick.)

const HEDGE_RATIO = Number(process.env.HEDGE_RATIO ?? 0.9);
const LEVERAGE = Number(process.env.LEVERAGE ?? 2);
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const MAX_HEDGE_USD = Number(process.env.MAX_HEDGE_USD ?? 30);
const MAX_MARKET_HEDGE_USD = Number(process.env.MAX_MARKET_HEDGE_USD ?? 15);
const MIN_ADJUST_USD = Number(process.env.MIN_ADJUST_USD ?? 12);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 20_000);
/** Sweep empty-account rent every N ticks while armed (~POLL_MS × N). */
const RECLAIM_EVERY_TICKS = Number(process.env.RECLAIM_EVERY_TICKS ?? 40);
/** Flash minimum collateral is $10; keep a buffer above it. */
const MIN_TICKET_USD = 11;

const log = (...a: unknown[]) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const hedger: Keypair = (() => {
  const p =
    process.env.HEDGER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/wick-hedger.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
})();
const OWNER = hedger.publicKey.toBase58();

const mainnet = new Connection(MAINNET_RPC, "confirmed");
const ctx = makeCtx(); // devnet/ER context for reading Wick books
const P = pdas(ctx.programId);

// ── Flash API plumbing ────────────────────────────────────────

async function flashPost(pathname: string, body: Record<string, unknown>): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${FLASH_API}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const dto: any = await res.json().catch(() => ({}));
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`); // retryable
      if (!res.ok || dto.err || dto.error) {
        throw Object.assign(
          new Error(`${pathname}: HTTP ${res.status} ${JSON.stringify(dto).slice(0, 220)}`),
          { fatal: true }
        );
      }
      return dto;
    } catch (e: any) {
      if (e?.fatal) throw e;
      lastErr = e;
      log(`  ${pathname.split("/").pop()}: attempt ${attempt} failed (${e?.name ?? e}), retrying…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`${pathname}: failed after retries — ${lastErr}`);
}

/** Build a V1 tx via Flash, restamp the blockhash, sign, broadcast to mainnet. */
async function buildSignSend(pathname: string, body: Record<string, unknown>): Promise<string> {
  const dto = await flashPost(pathname, body);
  const b64 = dto.transactionBase64;
  if (!b64) throw new Error(`${pathname}: no transactionBase64 in response`);
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const { blockhash, lastValidBlockHeight } = await mainnet.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  tx.sign([hedger]);
  const sig = await mainnet.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  log(`  ⚡ ${pathname.split("/").pop()} → ${sig}`);
  const conf = await mainnet.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (conf.value.err)
    throw new Error(`${pathname}: tx failed ${JSON.stringify(conf.value.err)}`);
  return sig;
}

// ── state readers ─────────────────────────────────────────────

interface Exposure {
  symbol: string;
  flashSymbol: string;
  netUsd: number; // signed: + = users net long
}

async function readExposures(): Promise<Exposure[]> {
  const books = await ctx.er.getMultipleAccountsInfo(MARKETS.map((m) => P.book(m.idx)));
  return MARKETS.map((m, i) => {
    const info = books[i];
    if (!info) return { symbol: m.symbol, flashSymbol: m.flashSymbol, netUsd: 0 };
    const b: any = ctx.program.coder.accounts.decode("marketBook", info.data as Buffer);
    return {
      symbol: m.symbol,
      flashSymbol: m.flashSymbol,
      netUsd: (b.longOpen.toNumber() - b.shortOpen.toNumber()) / 1e6,
    };
  });
}

interface FlashPos {
  positionKey: string;
  marketSymbol: string;
  side: "LONG" | "SHORT";
  sizeUsd: number;
}

interface FlashBook {
  positions: FlashPos[];
  /** signed USD size per flash symbol */
  signed: Record<string, number>;
}

/** Map a Flash V1 enriched position record (GET /positions/owner) to our shape. */
function parsePos(p: any): FlashPos | null {
  const positionKey = String(p.key ?? p.positionKey ?? p.pubkey ?? "");
  const sizeUsd = Number(p.sizeUsdUi ?? p.sizeUsd ?? 0);
  const market = String(p.marketSymbol ?? p.market ?? "").toUpperCase();
  const side = String(p.sideUi ?? p.side ?? "").toUpperCase().startsWith("S") ? "SHORT" : "LONG";
  if (!market || !positionKey || !isFinite(sizeUsd) || sizeUsd <= 0) return null;
  return { positionKey, marketSymbol: market, side, sizeUsd };
}

async function readFlashBook(): Promise<FlashBook> {
  const res = await fetch(
    `${FLASH_API}/positions/owner/${OWNER}?includePnlInLeverageDisplay=true`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`positions: HTTP ${res.status}`);
  const raw: any = await res.json();
  const list: any[] = Array.isArray(raw) ? raw : raw.positions ?? raw.data ?? [];
  const positions = list.map(parsePos).filter((p): p is FlashPos => p !== null);
  const signed: Record<string, number> = {};
  for (const p of positions) {
    signed[p.marketSymbol] =
      (signed[p.marketSymbol] ?? 0) + (p.side === "SHORT" ? -p.sizeUsd : p.sizeUsd);
  }
  return { positions, signed };
}

async function walletUsdc(): Promise<number> {
  const res = await mainnet.getParsedTokenAccountsByOwner(hedger.publicKey, {
    mint: new PublicKey(USDC_MINT),
  });
  return res.value.reduce(
    (s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
    0
  );
}

/**
 * Reclaim rent from EMPTY token accounts the wallet accumulates — Flash routes
 * collateral through transient JitoSOL/WSOL ATAs that linger at zero balance,
 * each locking ~0.002 SOL. Closing them returns that SOL. Never touches an
 * account with a non-zero balance. Returns the number of accounts closed.
 */
async function reclaimRent(): Promise<number> {
  const res = await mainnet.getParsedTokenAccountsByOwner(hedger.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });
  const empty = res.value.filter(
    (a) => (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0) === 0
  );
  if (empty.length === 0) return 0;
  // batch up to ~20 closes per tx to stay within size limits
  for (let i = 0; i < empty.length; i += 20) {
    const tx = new Transaction();
    for (const a of empty.slice(i, i + 20)) {
      tx.add(createCloseAccountInstruction(a.pubkey, hedger.publicKey, hedger.publicKey));
    }
    tx.feePayer = hedger.publicKey;
    const { blockhash, lastValidBlockHeight } = await mainnet.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(hedger);
    const sig = await mainnet.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await mainnet.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  }
  log(`reclaimed rent from ${empty.length} empty token account(s)`);
  return empty.length;
}

/** Recover deposited collateral from Flash's V2 deposit ledger back to the wallet. */
async function recoverV2(amountArg?: string): Promise<void> {
  const amount = amountArg ?? "25.0";
  await reclaimRent(); // free up SOL for the escrow rent the withdrawal needs
  log(`recovering $${amount} USDC from the Flash V2 deposit ledger…`);
  const before = await walletUsdc();
  try {
    await buildSignSend("/v2/transaction-builder/request-withdrawal", {
      owner: OWNER,
      tokenMint: USDC_MINT,
      amount,
      includeCustodySettlement: true,
    });
  } catch (e) {
    log("request-withdrawal failed:", e instanceof Error ? e.message.slice(0, 220) : e);
    log("if this is 'insufficient lamports', top up ~0.02 SOL and re-run `recover`.");
    return;
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const bal = await walletUsdc();
    log(`  wallet: $${bal.toFixed(2)} USDC`);
    if (bal > before + Number(amount) - 1) {
      log("recovered ✓");
      await reclaimRent(); // close the now-empty settlement escrow ATA
      return;
    }
  }
  log("not yet credited — trying execute-withdrawal to finish the escrow…");
  await buildSignSend("/v2/transaction-builder/execute-withdrawal", {
    owner: OWNER,
    tokenMint: USDC_MINT,
    amount,
  });
  await reclaimRent();
}

// ── hedging core ──────────────────────────────────────────────

const lastAdjust: Record<string, number> = {};

interface Action {
  desc: string;
  run: () => Promise<void>;
}

function closeAction(pos: FlashPos, usd: number, label: string): Action {
  return {
    desc: `${label} ${pos.side} $${usd.toFixed(2)}`,
    run: () =>
      buildSignSend("/transaction-builder/close-position", {
        positionKey: pos.positionKey,
        inputUsdUi: usd.toFixed(2),
        withdrawTokenSymbol: "USDC",
        slippagePercentage: "0.8",
      }).then(() => undefined),
  };
}

function openAction(flashSymbol: string, side: "LONG" | "SHORT", notional: number): Action {
  // Flash requires >$10 collateral per position: floor the collateral and let
  // effective leverage adapt (min 1.1x) so small hedges stay placeable.
  const collateral = Math.max(notional / LEVERAGE, 10.5);
  const leverage = Math.max(Math.round((notional / collateral) * 100) / 100, 1.1);
  return {
    desc: `open ${side} $${notional.toFixed(2)} (collat $${collateral.toFixed(2)} @ ${leverage}x)`,
    run: () =>
      buildSignSend("/transaction-builder/open-position", {
        inputTokenSymbol: "USDC",
        outputTokenSymbol: flashSymbol,
        inputAmountUi: collateral.toFixed(2),
        leverage,
        tradeType: side,
        orderType: "MARKET",
        owner: OWNER,
        slippagePercentage: "0.8",
      }).then(() => undefined),
  };
}

function planMarket(exp: Exposure, book: FlashBook, scale: number): Action[] {
  const positions = book.positions.filter((p) => p.marketSymbol === exp.flashSymbol);
  const currentSigned = book.signed[exp.flashSymbol] ?? 0;

  let target = exp.netUsd * HEDGE_RATIO * scale;
  target = Math.sign(target) * Math.min(Math.abs(target), MAX_MARKET_HEDGE_USD);
  if (Math.abs(target) < MIN_TICKET_USD) target = 0; // sub-minimum ⇒ flat

  if (Math.abs(target - currentSigned) < MIN_ADJUST_USD) return [];

  const actions: Action[] = [];
  let cur = currentSigned;

  const mustClose = cur !== 0 && (target === 0 || Math.sign(target) !== Math.sign(cur));
  if (mustClose) {
    // close every position on the wrong side, full size
    for (const p of positions) actions.push(closeAction(p, p.sizeUsd, "close"));
    cur = 0;
  }

  const remaining = target - cur;
  if (target !== 0 && Math.abs(remaining) >= MIN_ADJUST_USD) {
    if (Math.sign(remaining) === Math.sign(target)) {
      actions.push(openAction(exp.flashSymbol, target > 0 ? "LONG" : "SHORT", Math.abs(remaining)));
    } else if (positions[0]) {
      // over-hedged on the right side: trim the largest position partially
      actions.push(closeAction(positions[0], Math.abs(remaining), "trim"));
    }
  }
  return actions;
}

let busy = false;
let ticks = 0;

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const [exposures, book] = await Promise.all([readExposures(), readFlashBook()]);

    // global cap: scale every target down proportionally if the desk is over budget
    const totalWanted = exposures.reduce(
      (s, e) => s + Math.min(Math.abs(e.netUsd) * HEDGE_RATIO, MAX_MARKET_HEDGE_USD),
      0
    );
    const scale = totalWanted > MAX_HEDGE_USD ? MAX_HEDGE_USD / totalWanted : 1;
    if (scale < 1 && ticks % 10 === 0)
      log(`global cap engaged: scaling hedges by ${(scale * 100).toFixed(0)}%`);

    for (const exp of exposures) {
      const now = Date.now();
      if (now - (lastAdjust[exp.symbol] ?? 0) < COOLDOWN_MS) continue;
      const actions = planMarket(exp, book, scale);
      if (actions.length === 0) continue;

      log(
        `${exp.symbol}: users net ${exp.netUsd >= 0 ? "LONG" : "SHORT"} $${Math.abs(exp.netUsd).toFixed(2)} ` +
          `| desk ${(book.signed[exp.flashSymbol] ?? 0).toFixed(2)} → plan: ${actions.map((a) => a.desc).join(" → ")}` +
          (DRY_RUN ? "  [DRY RUN]" : "")
      );
      if (DRY_RUN) continue;

      for (const a of actions) await a.run();
      lastAdjust[exp.symbol] = Date.now();
    }

    if (++ticks % 20 === 0) {
      const desk = Object.entries(book.signed)
        .map(([s, v]) => `${s}:${v.toFixed(0)}`)
        .join(" ");
      log(`heartbeat — desk { ${desk || "flat"} } | ${DRY_RUN ? "DRY RUN" : "ARMED"}`);
    }
    // periodically sweep rent from the empty ATAs Flash's custody routing leaves behind
    if (!DRY_RUN && ticks % RECLAIM_EVERY_TICKS === 0) {
      await reclaimRent().catch((e) =>
        log("rent reclaim failed:", e instanceof Error ? e.message.slice(0, 120) : e)
      );
    }
  } catch (e) {
    log("tick failed:", e instanceof Error ? e.message.slice(0, 180) : e);
  } finally {
    busy = false;
  }
}

// ── flatten / withdraw / preview ──────────────────────────────

async function flattenAll(): Promise<void> {
  const book = await readFlashBook();
  if (book.positions.length === 0) {
    log("desk is already flat");
    return;
  }
  for (const p of book.positions) {
    log(`flatten: closing ${p.side} ${p.marketSymbol} $${p.sizeUsd.toFixed(2)}`);
    try {
      await closeAction(p, p.sizeUsd, "close").run();
    } catch (e) {
      log("  close failed:", e instanceof Error ? e.message.slice(0, 160) : e);
    }
  }
  // V1 settles collateral straight back to the wallet ATA — no withdrawal step.
}

async function preview(): Promise<void> {
  log("requesting a no-spend preview quote: LONG SOL, $11 collateral @ 2x …");
  const dto = await flashPost("/transaction-builder/open-position", {
    inputTokenSymbol: "USDC",
    outputTokenSymbol: "SOL",
    inputAmountUi: "11.00",
    leverage: 2,
    tradeType: "LONG",
    orderType: "MARKET",
    // no owner → preview-only mode, transactionBase64 is null
  });
  const { transactionBase64, ...quote } = dto;
  log("quote:", JSON.stringify(quote).slice(0, 600));
  log(`transactionBase64 is ${transactionBase64 == null ? "null (preview mode ✓)" : "present"}`);
}

// ── entrypoint ────────────────────────────────────────────────

async function main(): Promise<void> {
  log(
    `wick hedger [${MODE}] — ${DRY_RUN ? "DRY RUN" : "⚠ ARMED ⚠"} | desk=${OWNER}` +
      ` | caps: total $${MAX_HEDGE_USD}, per-market $${MAX_MARKET_HEDGE_USD}, ratio ${HEDGE_RATIO}, ${LEVERAGE}x`
  );

  if (MODE === "preview") return preview();
  if (MODE === "flatten") {
    await flattenAll();
    await reclaimRent();
    return;
  }
  if (MODE === "reclaim") {
    const n = await reclaimRent();
    if (n === 0) log("no empty token accounts to reclaim");
    return;
  }
  if (MODE === "recover") return recoverV2(process.argv[3]);

  const usdc = await walletUsdc().catch(() => NaN);
  log(`wallet: $${isFinite(usdc) ? usdc.toFixed(2) : "?"} USDC on mainnet (V1 pays collateral per position)`);

  if (!DRY_RUN) {
    let flattening = false;
    const flatten = async (sig: string) => {
      if (flattening) return;
      flattening = true;
      log(`${sig} received — flattening the desk before exit…`);
      try {
        await flattenAll();
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void flatten("SIGINT"));
    process.on("SIGTERM", () => void flatten("SIGTERM"));
    log("auto-flatten armed: Ctrl-C / kill closes all positions before exiting");
  }

  setInterval(tick, POLL_MS);
  void tick();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
