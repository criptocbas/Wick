import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

type LaneState = { ms: number | null; running: boolean };
const ARM = "settling…";

/**
 * The latency duel — the demo's money shot. Fires the SAME transaction on the
 * Ephemeral Rollup and on Solana L1 at the same instant and races them. The ER
 * lands first, gaslessly; L1 lags and charges a fee. This is why 5-second
 * options exist on Wick and nowhere else.
 */
export default function LatencyDuel() {
  const open = useStore((s) => s.duelOpen);
  const toggle = useStore((s) => s.toggleDuel);
  const client = useStore((s) => s.client);
  const [er, setEr] = useState<LaneState>({ ms: null, running: false });
  const [l1, setL1] = useState<LaneState>({ ms: null, running: false });
  const [busy, setBusy] = useState(false);
  const [warming, setWarming] = useState(false);
  const tickRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  async function run() {
    if (!client || busy) return;
    setBusy(true);
    setWarming(true);
    setEr({ ms: null, running: true });
    setL1({ ms: null, running: true });
    setElapsed(0);
    try {
      await client.latencyDuel({
        onStart: () => {
          setWarming(false);
          startRef.current = performance.now();
          if (tickRef.current) clearInterval(tickRef.current);
          tickRef.current = window.setInterval(
            () => setElapsed(performance.now() - startRef.current),
            16
          );
        },
        onEr: (ms) => setEr({ ms, running: false }),
        onL1: (ms) => setL1({ ms, running: false }),
      });
    } catch {
      /* one lane may error; whatever landed stays shown */
    } finally {
      if (tickRef.current) clearInterval(tickRef.current);
      setBusy(false);
      setWarming(false);
    }
  }

  useEffect(() => {
    if (open && !busy && er.ms === null && l1.ms === null) void run();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  // progress: a lane "fills" over its expected time, then snaps to done
  const laneFill = (lane: LaneState, expected: number) =>
    lane.ms != null ? 100 : Math.min((elapsed / expected) * 100, 96);
  const speedup =
    er.ms != null && l1.ms != null && er.ms > 0 ? (l1.ms / er.ms).toFixed(1) : null;

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
              className={`lane-fill er ${er.ms != null ? "done" : ""}`}
              style={{ width: `${laneFill(er, 500)}%` }}
            />
            <span className="lane-ember er-ember" style={{ left: `${laneFill(er, 500)}%` }} />
          </div>
          <div className="lane-time num">
            {er.ms != null ? `${er.ms}ms` : warming ? "warming" : er.running ? ARM : ""}
          </div>
        </div>

        <div className="lane">
          <div className="lane-label">
            <span className="lane-name">Solana L1</span>
            <span className="lane-tag">pays a fee · slower</span>
          </div>
          <div className="lane-track">
            <div
              className={`lane-fill l1 ${l1.ms != null ? "done" : ""}`}
              style={{ width: `${laneFill(l1, 1600)}%` }}
            />
            <span className="lane-ember l1-ember" style={{ left: `${laneFill(l1, 1600)}%` }} />
          </div>
          <div className="lane-time num">
            {l1.ms != null ? `${l1.ms}ms` : warming ? "warming" : l1.running ? ARM : ""}
          </div>
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
          <button className="duel-again" onClick={() => void run()} disabled={busy}>
            {busy ? "racing…" : "Race again"}
          </button>
        </div>
      </div>
    </div>
  );
}
