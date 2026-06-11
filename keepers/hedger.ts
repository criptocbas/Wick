/**
 * The Flash Trade hedger — Wick's risk desk.
 *
 * Every poll it reads each market's open interest from the delegated books on
 * the EPHEMERAL ROLLUP, computes the house's net directional exposure, and
 * offsets it with real perp positions on FLASH TRADE MAINNET via the V2
 * transaction-builder API. Users' net-long flow ⇒ the house is implicitly
 * short ⇒ the hedger goes LONG the same notional on Flash (and vice versa).
 *
 *   DRY_RUN=1 (default)  log intended hedges, send nothing
 *   DRY_RUN=0            sign + send with HEDGER_KEYPAIR on mainnet
 *
 * env: HEDGER_KEYPAIR (path, default ~/.config/solana/id.json — use a separate
 *      funded wallet in production), MAINNET_RPC, HEDGE_RATIO (default 0.9),
 *      LEVERAGE (default 2), POLL_MS (default 3000), FLASH_API.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { MARKETS, makeCtx, pdas } from "./common";

const DRY_RUN = process.env.DRY_RUN !== "0";
const FLASH_API = process.env.FLASH_API ?? "https://flashapi.trade";
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const HEDGE_RATIO = Number(process.env.HEDGE_RATIO ?? 0.9);
const LEVERAGE = Number(process.env.LEVERAGE ?? 2);
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
/** Flash minimum is $10 collateral; don't bother adjusting below this. */
const MIN_ADJUST_USD = Number(process.env.MIN_ADJUST_USD ?? 12);

const ctx = makeCtx();
const P = pdas(ctx.programId);
const mainnet = new Connection(MAINNET_RPC, "confirmed");

const hedger: Keypair = (() => {
  const p =
    process.env.HEDGER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
})();

interface Exposure {
  symbol: string;
  flashSymbol: string;
  /** signed users' net exposure in USD: + = users net long */
  netUsd: number;
}

async function readExposures(): Promise<Exposure[]> {
  const books = await ctx.er.getMultipleAccountsInfo(MARKETS.map((m) => P.book(m.idx)));
  return MARKETS.map((m, i) => {
    const info = books[i];
    if (!info) return { symbol: m.symbol, flashSymbol: m.flashSymbol, netUsd: 0 };
    const b: any = ctx.program.coder.accounts.decode("marketBook", info.data as Buffer);
    const netUsd = (b.longOpen.toNumber() - b.shortOpen.toNumber()) / 1e6;
    return { symbol: m.symbol, flashSymbol: m.flashSymbol, netUsd };
  });
}

interface FlashPosition {
  side: "LONG" | "SHORT";
  sizeUsd: number;
}

/** Current hedge book on Flash: signed USD size per market symbol. */
async function readFlashBook(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const res = await fetch(`${FLASH_API}/v2/owner/${hedger.publicKey.toBase58()}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return out; // no basket yet
    const body: any = await res.json();
    const positions: any[] = body.positions ?? body.basket?.positions ?? [];
    for (const p of positions) {
      const sym = String(p.marketSymbol ?? p.market ?? p.symbol ?? "").toUpperCase();
      const side = String(p.side ?? p.tradeType ?? "").toUpperCase();
      const size = Number(p.sizeUsd ?? p.sizeUsdUi ?? p.size ?? 0);
      if (!sym || !isFinite(size)) continue;
      out[sym] = (out[sym] ?? 0) + (side === "SHORT" ? -size : size);
    }
  } catch (e) {
    console.warn("flash book read failed:", e instanceof Error ? e.message : e);
  }
  return out;
}

async function buildAndSend(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${FLASH_API}/v2/transaction-builder/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const dto: any = await res.json();
  if (!res.ok || dto.err) throw new Error(`${endpoint}: ${JSON.stringify(dto).slice(0, 200)}`);
  const b64 = dto.transactionBase64;
  if (!b64) throw new Error(`${endpoint}: no transaction returned`);
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([hedger]);
  const sig = await mainnet.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`  ⚡ ${endpoint} sent: ${sig}`);
  await mainnet.confirmTransaction(sig, "confirmed");
}

async function adjust(exp: Exposure, currentSigned: number): Promise<void> {
  const target = exp.netUsd * HEDGE_RATIO;
  const delta = target - currentSigned;
  if (Math.abs(delta) < MIN_ADJUST_USD) return;

  const plan: string[] = [];
  const actions: (() => Promise<void>)[] = [];

  const flip = currentSigned !== 0 && Math.sign(target) !== Math.sign(currentSigned) && target !== 0;
  if (flip || (target === 0 && currentSigned !== 0)) {
    const side = currentSigned > 0 ? "LONG" : "SHORT";
    plan.push(`close ${side} $${Math.abs(currentSigned).toFixed(2)}`);
    actions.push(() =>
      buildAndSend("close-position", {
        marketSymbol: exp.flashSymbol,
        side,
        inputUsdUi: Math.abs(currentSigned).toFixed(2),
        withdrawTokenSymbol: "USDC",
        owner: hedger.publicKey.toBase58(),
      })
    );
    currentSigned = 0;
  }

  const remaining = target - currentSigned;
  if (Math.abs(remaining) >= MIN_ADJUST_USD && target !== 0) {
    if (Math.sign(remaining) === Math.sign(target)) {
      const side = target > 0 ? "LONG" : "SHORT";
      const collateral = Math.max(Math.abs(remaining) / LEVERAGE, 11);
      plan.push(`open ${side} $${Math.abs(remaining).toFixed(2)} (collat $${collateral.toFixed(2)} @ ${LEVERAGE}x)`);
      actions.push(() =>
        buildAndSend("open-position", {
          inputTokenSymbol: "USDC",
          outputTokenSymbol: exp.flashSymbol,
          inputAmountUi: collateral.toFixed(2),
          leverage: LEVERAGE,
          tradeType: side,
          orderType: "MARKET",
          owner: hedger.publicKey.toBase58(),
          slippagePercentage: "0.8",
        })
      );
    } else {
      const side = currentSigned > 0 ? "LONG" : "SHORT";
      plan.push(`trim ${side} by $${Math.abs(remaining).toFixed(2)}`);
      actions.push(() =>
        buildAndSend("close-position", {
          marketSymbol: exp.flashSymbol,
          side,
          inputUsdUi: Math.abs(remaining).toFixed(2),
          withdrawTokenSymbol: "USDC",
          owner: hedger.publicKey.toBase58(),
        })
      );
    }
  }

  if (plan.length === 0) return;
  console.log(
    `${exp.symbol}: users net ${exp.netUsd >= 0 ? "LONG" : "SHORT"} $${Math.abs(exp.netUsd).toFixed(2)} → ` +
      `hedge target $${target.toFixed(2)}, current $${currentSigned.toFixed(2)} | ${plan.join(" → ")}` +
      (DRY_RUN ? "  [DRY RUN]" : "")
  );
  if (DRY_RUN) return;
  for (const act of actions) await act();
}

let busy = false;

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const [exposures, flashBook] = await Promise.all([readExposures(), readFlashBook()]);
    for (const exp of exposures) {
      await adjust(exp, flashBook[exp.flashSymbol] ?? 0);
    }
  } catch (e) {
    console.warn("hedger tick failed:", e instanceof Error ? e.message.slice(0, 160) : e);
  } finally {
    busy = false;
  }
}

console.log(
  `wick hedger — ${DRY_RUN ? "DRY RUN" : "LIVE"} | hedger=${hedger.publicKey.toBase58()} | ratio=${HEDGE_RATIO} leverage=${LEVERAGE}x | flash=${FLASH_API}`
);
setInterval(tick, POLL_MS);
void tick();
