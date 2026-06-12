import { useRef } from "react";
import { marketStatusOf, useStore } from "../state/store";
import { fmtPrice } from "../util";

const CRYPTO = new Set(["SOL", "BTC", "ETH"]);

export default function MarketRail() {
  const config = useStore((s) => s.config);
  const feeds = useStore((s) => s.feeds);
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const lastPrices = useRef<Record<string, number>>({});

  if (!config) return <nav className="rail" />;

  const crypto = config.markets.filter((m) => CRYPTO.has(m.symbol));
  const exotic = config.markets.filter((m) => !CRYPTO.has(m.symbol));

  const row = (m: (typeof config.markets)[number]) => {
    const f = feeds[m.symbol];
    const status = marketStatusOf(feeds, sessions, m.symbol);
    const prev = lastPrices.current[m.symbol];
    let tick = "";
    if (f && prev !== undefined && f.price !== prev)
      tick = f.price > prev ? "tick-up" : "tick-down";
    if (f) lastPrices.current[m.symbol] = f.price;

    return (
      <button
        key={m.idx}
        className={`market-row ${m.idx === selected ? "active" : ""} ${
          status.closed ? "closed" : ""
        }`}
        onClick={() => select(m.idx)}
      >
        <span className="sym">{m.symbol}</span>
        {status.closed ? (
          <span className="px closed-tag">{status.reason}</span>
        ) : (
          <span className={`px num ${tick}`}>
            {f ? fmtPrice(f.price, m.display) : "·"}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav className="rail" aria-label="markets">
      <div className="rail-caption">Crypto</div>
      {crypto.map(row)}
      {exotic.length > 0 && (
        <>
          <div className="rail-caption">Via Flash Trade</div>
          {exotic.map(row)}
        </>
      )}
    </nav>
  );
}
