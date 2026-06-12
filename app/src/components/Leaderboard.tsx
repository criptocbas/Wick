import { useStore } from "../state/store";

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const signed = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Your record + the streak leaderboard. Your own stats come from the user
 * account (reliable everywhere); the board folds in when the RPC serves it.
 */
export default function Leaderboard() {
  const open = useStore((s) => s.boardOpen);
  const toggle = useStore((s) => s.toggleBoard);
  const user = useStore((s) => s.user);
  const board = useStore((s) => s.board);
  const me = useStore((s) => s.client?.wallet.publicKey.toBase58());
  if (!open) return null;

  const total = user ? user.wins + user.losses : 0;
  const winRate = total ? Math.round((user!.wins / total) * 100) : 0;

  return (
    <div className="board-scrim" onClick={() => toggle(false)}>
      <div className="board-card" onClick={(e) => e.stopPropagation()}>
        <header className="trust-head">
          <div>
            <div className="trust-title">Streaks</div>
            <div className="trust-sub">who's running hottest on Wick</div>
          </div>
          <button className="desk-close" onClick={() => toggle(false)} aria-label="close">
            ✕
          </button>
        </header>

        {user && (
          <div className="me-card">
            <div className="me-head">
              <span className="me-label">Your record</span>
              {user.streak > 0 && (
                <span className="me-streak num">🔥 {user.streak} live</span>
              )}
            </div>
            <div className="me-stats">
              <div>
                <span className="num">{user.wins}</span>
                <label>wins</label>
              </div>
              <div>
                <span className="num">{user.losses}</span>
                <label>losses</label>
              </div>
              <div>
                <span className="num">{winRate}%</span>
                <label>win rate</label>
              </div>
              <div>
                <span className="num">{user.bestStreak}</span>
                <label>best streak</label>
              </div>
              <div>
                <span className={`num ${user.pnl >= 0 ? "up" : "down"}`}>
                  {signed(user.pnl / 1e6)}
                </span>
                <label>net P&amp;L</label>
              </div>
            </div>
          </div>
        )}

        <div className="desk-section-label">Top streaks</div>
        {board.length === 0 ? (
          <div className="desk-empty">
            Be the first on the board — string together a win streak.
          </div>
        ) : (
          <div className="board-rows">
            <div className="board-row board-header">
              <span>#</span>
              <span>player</span>
              <span className="num">best</span>
              <span className="num">W/L</span>
              <span className="num">P&amp;L</span>
            </div>
            {board.map((r, i) => (
              <div
                key={r.wallet}
                className={`board-row ${r.wallet === me ? "is-me" : ""}`}
              >
                <span className="board-rank">{i + 1}</span>
                <span className="board-player">
                  {r.wallet === me ? "you" : short(r.wallet)}
                </span>
                <span className="num board-best">🔥 {r.bestStreak}</span>
                <span className="num board-wl">
                  {r.wins}/{r.losses}
                </span>
                <span className={`num ${r.pnlUsd >= 0 ? "up" : "down"}`}>
                  {signed(r.pnlUsd)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
