import { useStore } from "../state/store";
import { fmtMoney } from "../util";

export default function TopBar({ onSettle }: { onSettle: () => void }) {
  const user = useStore((s) => s.user);
  const soundOn = useStore((s) => s.soundOn);
  const toggleSound = useStore((s) => s.toggleSound);
  const busy = useStore((s) => s.busy);
  const toggleDesk = useStore((s) => s.toggleDesk);
  const toggleDuel = useStore((s) => s.toggleDuel);
  const toggleTrust = useStore((s) => s.toggleTrust);
  const toggleBoard = useStore((s) => s.toggleBoard);
  const desk = useStore((s) => s.desk);
  const duel = useStore((s) => s.duel);
  const hedgeCount = desk?.positions.length ?? 0;
  const hedgedUsd = desk?.positions.reduce((s, p) => s + p.sizeUsd, 0) ?? 0;
  const speedup =
    duel.er != null && duel.l1 != null && duel.er > 0
      ? Math.round(duel.l1 / duel.er)
      : null;

  return (
    <header className="topbar">
      <div className="wordmark" aria-label="Wick">
        W<span className="tittle">ı</span>ck
      </div>

      {/* ambient latency duel — the ER advantage, always on screen */}
      <button
        className="duel-strip"
        onClick={() => toggleDuel(true)}
        title="race the Ephemeral Rollup against Solana L1"
      >
        <span className="duel-strip-lane">
          <span className="duel-strip-k flame">ER</span>
          <span className="num">{duel.er != null ? `${duel.er}ms` : duel.running ? "…" : "—"}</span>
        </span>
        <span className="duel-strip-vs">vs</span>
        <span className="duel-strip-lane">
          <span className="duel-strip-k">L1</span>
          <span className="num dim">
            {duel.l1 != null ? `${duel.l1}ms` : duel.running ? "…" : "—"}
          </span>
        </span>
        {speedup != null && <span className="duel-strip-x num">{speedup}× faster ↗</span>}
      </button>

      <button
        className="trust-pill"
        onClick={() => toggleTrust(true)}
        title="why your money is safe"
      >
        ◆ Provably fair
      </button>

      {/* always-visible proof the +50% Flash integration is real */}
      {hedgeCount > 0 && (
        <button
          className="hedge-badge"
          onClick={() => toggleDesk(true)}
          title="the house's live offsetting positions on Flash Trade mainnet"
        >
          <span className="flash-dot" />
          hedged <strong className="num">${Math.round(hedgedUsd)}</strong> on Flash Trade
        </button>
      )}

      <div className="topbar-spacer" />

      <button
        className="streak streak-btn"
        onClick={() => toggleBoard()}
        title="your record & the streak leaderboard"
      >
        <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden>
          <path d="M16 3c1 5-7 9-7 16a7 7 0 0 0 14 0c0-3-1.5-5-2.5-7-1.6 2-2.5 2.4-2.5 2.4S20 8 16 3z" />
        </svg>
        {user && user.streak > 1 ? (
          <span className="num">{user.streak}</span>
        ) : (
          <span className="streak-label">Streaks</span>
        )}
      </button>

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
