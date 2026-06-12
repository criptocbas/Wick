import { useStore } from "../state/store";
import { fmtMoney } from "../util";

export default function TopBar({ onSettle }: { onSettle: () => void }) {
  const user = useStore((s) => s.user);
  const latency = useStore((s) => s.lastLatency);
  const soundOn = useStore((s) => s.soundOn);
  const toggleSound = useStore((s) => s.toggleSound);
  const busy = useStore((s) => s.busy);
  const toggleDesk = useStore((s) => s.toggleDesk);
  const toggleDuel = useStore((s) => s.toggleDuel);
  const desk = useStore((s) => s.desk);
  const hedgeCount = desk?.positions.length ?? 0;

  return (
    <header className="topbar">
      <div className="wordmark" aria-label="Wick">
        W<span className="tittle">ı</span>ck
      </div>

      <button
        className="latency-pill"
        onClick={() => toggleDuel(true)}
        title="race the Ephemeral Rollup against Solana L1"
      >
        {latency != null ? (
          <>
            rollup <strong className="num">{latency}ms</strong>
          </>
        ) : (
          "rollup ready"
        )}
        <span className="latency-vs"> · vs L1 ↗</span>
      </button>

      <div className="topbar-spacer" />

      {user && user.streak > 1 && (
        <div className="streak" title={`${user.streak} wins in a row`}>
          <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden>
            <path d="M16 3c1 5-7 9-7 16a7 7 0 0 0 14 0c0-3-1.5-5-2.5-7-1.6 2-2.5 2.4-2.5 2.4S20 8 16 3z" />
          </svg>
          <span className="num">{user.streak}</span>
        </div>
      )}

      <div className="balance-block">
        <div className="label">balance</div>
        <div className="value num">{user ? fmtMoney(user.balance) : "—"}</div>
      </div>

      <button
        className={`btn-quiet desk-btn ${hedgeCount > 0 ? "live" : ""}`}
        onClick={() => toggleDesk()}
        aria-label="house risk desk"
      >
        Desk
        {hedgeCount > 0 && <span className="desk-pip" />}
      </button>
      <button className="btn-quiet" onClick={toggleSound} aria-label="toggle sound">
        {soundOn ? "Sound on" : "Muted"}
      </button>
      <button className="btn-quiet" onClick={onSettle} disabled={busy}>
        Settle up
      </button>
    </header>
  );
}
