import { useStore } from "../state/store";

const fmt = (n: number) =>
  `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * House book P&L vs live hedge P&L on one chart — the risk engine made visible.
 * The book line grinds upward on the published edge; the hedge line offsets net
 * direction with real Flash Trade perps. Both streams already exist on-chain
 * (house.lifetime_pnl) and on Flash (position P&L); this just shows them together.
 */
export default function PnlChart() {
  const series = useStore((s) => s.pnlSeries);
  const desk = useStore((s) => s.desk);

  const book = desk?.house?.lifetimePnlUsd ?? 0;
  const hedge = desk?.hedgePnlUsd ?? 0;

  if (series.length < 2) {
    return (
      <div className="pnl-chart">
        <div className="pnl-legend">
          <span className="pnl-k book">
            House book <b className="num">{fmt(book)}</b>
          </span>
          <span className="pnl-k hedge">
            Hedge (live) <b className="num">{fmt(hedge)}</b>
          </span>
        </div>
        <div className="pnl-empty">building as bets settle…</div>
      </div>
    );
  }

  const W = 300;
  const H = 64;
  const pad = 5;
  const vals = series.flatMap((p) => [p.book, p.hedge]).concat(0);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1) {
    hi += 1;
    lo -= 1;
  }
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const path = (key: "book" | "hedge") =>
    series
      .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`)
      .join(" ");
  const zeroY = y(0).toFixed(1);

  return (
    <div className="pnl-chart">
      <div className="pnl-legend">
        <span className="pnl-k book">
          House book <b className="num">{fmt(book)}</b>
        </span>
        <span className="pnl-k hedge">
          Hedge (live) <b className="num">{fmt(hedge)}</b>
        </span>
      </div>
      <svg className="pnl-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line
          x1={0}
          x2={W}
          y1={zeroY}
          y2={zeroY}
          className="pnl-zero"
          vectorEffect="non-scaling-stroke"
        />
        <path d={path("book")} className="pnl-line book" vectorEffect="non-scaling-stroke" />
        <path d={path("hedge")} className="pnl-line hedge" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="pnl-caption">
        The book grinds the published edge; the hedge offsets net direction on Flash.
      </div>
    </div>
  );
}
