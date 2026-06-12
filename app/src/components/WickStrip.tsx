import { useEffect, useRef } from "react";
import { useStore, openBets } from "../state/store";
import { applyExpo, fmtMoney, fmtPrice } from "../util";
import { DIRECTION_UP, type Bet } from "../chain/wick";

/** A live bet: a fuse burning down in real time. */
function Strip({ bet }: { bet: Bet }) {
  const config = useStore((s) => s.config);
  const feeds = useStore((s) => s.feeds);
  const burnRef = useRef<HTMLDivElement>(null);
  const emberRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);

  const market = config?.markets.find((m) => m.idx === bet.marketIdx);
  const feed = market ? feeds[market.symbol] : undefined;
  // Feed time is the settlement clock; anchor it to the wall clock between
  // updates. Oracle prints truncate to seconds, so keep the max offset seen —
  // it converges on the true clock skew instead of stuttering ±1s.
  const offsetRef = useRef<number | null>(null);
  if (feed) {
    const off = feed.tsMs - Date.now();
    if (offsetRef.current === null || off > offsetRef.current) offsetRef.current = off;
  }

  useEffect(() => {
    let raf = 0;
    const total = bet.expiryMs - bet.placedMs;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const nowChain = Date.now() + (offsetRef.current ?? 0);
      const remaining = Math.max(bet.expiryMs - nowChain, 0);
      const frac = Math.min(Math.max(remaining / total, 0), 1);
      if (burnRef.current) burnRef.current.style.width = `${frac * 100}%`;
      if (emberRef.current) emberRef.current.style.left = `calc(${frac * 100}% - 3px)`;
      if (countRef.current)
        countRef.current.textContent =
          remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "···";
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bet.expiryMs, bet.placedMs]);

  const isUp = bet.direction === DIRECTION_UP;
  const strike = applyExpo(bet.strike, bet.expo);

  return (
    <div className="wick-strip" role="status">
      <div className="fuse">
        <div className="rope" />
        <div ref={burnRef} className="burn" />
        <div ref={emberRef} className="ember" />
      </div>
      <div className="row">
        <span className={`dir ${isUp ? "up" : "down"}`}>
          {isUp ? "▲ LONG" : "▼ SHORT"} {market?.symbol}
        </span>
        <span ref={countRef} className="countdown num" />
      </div>
      <div className="row">
        <span className="meta num">
          {fmtMoney(bet.stake)} @ {fmtPrice(strike, market?.display ?? 2)}
        </span>
        <span className="meta num">→ {fmtMoney(bet.stake + bet.potentialProfit)}</span>
      </div>
    </div>
  );
}

function PendingStrip({ symbol }: { symbol: string }) {
  return (
    <div className="wick-strip" role="status">
      <div className="fuse">
        <div className="rope" />
        <div className="burn" style={{ width: "100%" }} />
        <div className="ember" style={{ left: "calc(100% - 3px)" }} />
      </div>
      <div className="row">
        <span className="dir" style={{ color: "var(--flame)" }}>
          striking the match…
        </span>
        <span className="meta">{symbol}</span>
      </div>
    </div>
  );
}

export function WickStrips() {
  const user = useStore((s) => s.user);
  const pending = useStore((s) => s.pending);
  const config = useStore((s) => s.config);
  const bets = openBets(user);

  if (bets.length === 0 && pending.length === 0) return null;

  return (
    <div className="wicks">
      {bets.map((b) => (
        <Strip key={`${b.slot}-${b.placedMs}`} bet={b} />
      ))}
      {pending.map((p) => (
        <PendingStrip
          key={p.id}
          symbol={config?.markets.find((m) => m.idx === p.marketIdx)?.symbol ?? ""}
        />
      ))}
    </div>
  );
}
