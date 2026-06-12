import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

const ARM = "settling…";

/**
 * The latency duel — the demo's money shot. Fires the SAME transaction on the
 * Ephemeral Rollup and on Solana L1 at the same instant and races them. The ER
 * lands first, gaslessly; L1 lags and charges a fee. This is why 5-second
 * options exist on Wick and nowhere else. The result lives in the store so the
 * always-visible top-bar strip and this modal show the same numbers.
 */
export default function LatencyDuel() {
  const open = useStore((s) => s.duelOpen);
  const toggle = useStore((s) => s.toggleDuel);
  const duel = useStore((s) => s.duel);
  const runDuel = useStore((s) => s.runDuel);
  const { er, l1, running } = duel;

  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);

  // Drive the fill animation off a local clock that starts when a race starts.
  useEffect(() => {
    if (running) {
      const t0 = performance.now();
      setElapsed(0);
      tickRef.current = window.setInterval(() => setElapsed(performance.now() - t0), 16);
    } else if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running]);

  // Auto-race the first time the modal is opened with no standing result.
  useEffect(() => {
    if (open && !running && er === null && l1 === null) void runDuel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const laneFill = (ms: number | null, expected: number) =>
    ms != null ? 100 : Math.min((elapsed / expected) * 100, 96);
  const speedup = er != null && l1 != null && er > 0 ? (l1 / er).toFixed(1) : null;
  const laneTime = (ms: number | null) =>
    ms != null ? `${ms}ms` : running ? ARM : "";

  return (
    <div className="duel-scrim" onClick={() => toggle(false)}>
      <div className="duel-card" onClick={(e) => e.stopPropagation()}>
        <header className="duel-head">
          <div>
            <div className="duel-title">Same transaction. Two layers.</div>
            <div className="duel-sub">
              identical memo, fired at the same instant — confirmation time
            </div>
          </div>
          <button className="desk-close" onClick={() => toggle(false)} aria-label="close">
            ✕
          </button>
        </header>

        <div className="lane">
          <div className="lane-label">
            <span className="lane-name flame">Ephemeral Rollup</span>
            <span className="lane-tag">gasless · no popup</span>
          </div>
          <div className="lane-track">
            <div
              className={`lane-fill er ${er != null ? "done" : ""}`}
              style={{ width: `${laneFill(er, 500)}%` }}
            />
            <span className="lane-ember er-ember" style={{ left: `${laneFill(er, 500)}%` }} />
          </div>
          <div className="lane-time num">{laneTime(er)}</div>
        </div>

        <div className="lane">
          <div className="lane-label">
            <span className="lane-name">Solana L1</span>
            <span className="lane-tag">pays a fee · slower</span>
          </div>
          <div className="lane-track">
            <div
              className={`lane-fill l1 ${l1 != null ? "done" : ""}`}
              style={{ width: `${laneFill(l1, 1600)}%` }}
            />
            <span className="lane-ember l1-ember" style={{ left: `${laneFill(l1, 1600)}%` }} />
          </div>
          <div className="lane-time num">{laneTime(l1)}</div>
        </div>

        <div className="duel-foot">
          {speedup ? (
            <span className="duel-verdict">
              <strong className="num">{speedup}×</strong> faster on the rollup — and
              a 5-second option simply can't settle at L1 latency.
            </span>
          ) : (
            <span className="duel-note">
              measured live from your browser; the rollup's block time is 50ms —
              network round-trip is the floor.
            </span>
          )}
          <button className="duel-again" onClick={() => void runDuel()} disabled={running}>
            {running ? "racing…" : "Race again"}
          </button>
        </div>
      </div>
    </div>
  );
}
