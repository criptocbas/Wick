import { useStore } from "../state/store";
import PnlChart from "./PnlChart";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const solscan = (addr: string) => `https://solscan.io/account/${addr}`;

/**
 * The House Desk drawer — makes the risk engine visible. Shows, per market, the
 * net direction users are leaning, and the REAL offsetting perpetual positions
 * the house holds on Flash Trade mainnet. This is the +50% integration, on screen.
 */
export default function HouseDesk() {
  const open = useStore((s) => s.deskOpen);
  const toggle = useStore((s) => s.toggleDesk);
  const desk = useStore((s) => s.desk);

  const exposures = (desk?.exposure ?? []).filter(
    (e) => Math.abs(e.netUsd) > 0.001 || desk?.positions.some((p) => p.market === e.symbol)
  );
  const positions = desk?.positions ?? [];
  const hedgedUsd = positions.reduce((s, p) => s + p.sizeUsd, 0);

  return (
    <>
      <div
        className={`desk-scrim ${open ? "show" : ""}`}
        onClick={() => toggle(false)}
        aria-hidden
      />
      <aside className={`desk-drawer ${open ? "open" : ""}`} aria-label="house risk desk">
        <header className="desk-head">
          <div>
            <div className="desk-title">House Desk</div>
            <div className="desk-sub">net flow, hedged live on Flash Trade</div>
          </div>
          <button className="desk-close" onClick={() => toggle(false)} aria-label="close">
            ✕
          </button>
        </header>

        <p className="desk-explainer">
          Wick is the counterparty to every position. The desk reads net trader
          flow from the rollup and offsets its <strong>direction</strong> with real
          Flash Trade mainnet perps — a live directional hedge (it covers net delta,
          not the full gamma of a binary book).
        </p>

        <div className="desk-stat-row">
          <div className="desk-stat">
            <span className="k">Open hedge</span>
            <span className="v num">${fmtUsd(hedgedUsd)}</span>
          </div>
          <div className="desk-stat">
            <span className="k">Positions</span>
            <span className="v num">{positions.length}</span>
          </div>
        </div>

        <PnlChart />

        <div className="desk-section-label">Net trader flow</div>
        {exposures.length === 0 ? (
          <div className="desk-empty">No open interest right now.</div>
        ) : (
          <div className="desk-exposure">
            {exposures.map((e) => {
              const total = e.longUsd + e.shortUsd || 1;
              const longPct = (e.longUsd / total) * 100;
              const lean = e.netUsd >= 0 ? "long" : "short";
              return (
                <div key={e.symbol} className="exp-row">
                  <div className="exp-top">
                    <span className="exp-sym">{e.symbol}</span>
                    <span className={`exp-net ${lean}`}>
                      {e.netUsd >= 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(e.netUsd))} {lean}
                    </span>
                  </div>
                  <div className="exp-bar">
                    <div className="exp-long" style={{ width: `${longPct}%` }} />
                    <div className="exp-short" style={{ width: `${100 - longPct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="desk-section-label">
          Live hedge on Flash Trade
          {desk?.hedger && (
            <a
              className="desk-wallet"
              href={solscan(desk.hedger)}
              target="_blank"
              rel="noreferrer"
            >
              {desk.hedger.slice(0, 4)}…{desk.hedger.slice(-4)} ↗
            </a>
          )}
        </div>
        {positions.length === 0 ? (
          <div className="desk-empty">
            Desk is flat — no hedge needed at current exposure.
          </div>
        ) : (
          <div className="desk-positions">
            {positions.map((p, i) => (
              <a
                key={p.key ?? i}
                className="pos-row"
                href={p.key ? solscan(p.key) : "#"}
                target="_blank"
                rel="noreferrer"
              >
                <span className={`pos-side ${p.side.toLowerCase()}`}>
                  {p.side === "LONG" ? "▲" : "▼"} {p.side}
                </span>
                <span className="pos-mkt">{p.market}</span>
                <span className="pos-size num">${fmtUsd(p.sizeUsd)}</span>
                {p.pnlUsd != null && (
                  <span
                    className={`pos-pnl num ${
                      Number(p.pnlUsd) >= 0 ? "up" : "down"
                    }`}
                  >
                    {Number(p.pnlUsd) >= 0 ? "+" : ""}
                    {p.pnlUsd}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}

        <div className="desk-foot">
          <span className="flash-dot" /> positions are real, on Flash Trade mainnet
        </div>
        <div className="desk-caveat">
          Demo book is play-money wUSDC; the hedge round-trip is real capital.
        </div>
      </aside>
    </>
  );
}
