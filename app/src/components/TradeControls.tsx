import { marketStatusOf, useStore } from "../state/store";
import { toUnits } from "../chain/config";
import { DIRECTION_DOWN, DIRECTION_UP } from "../chain/wick";
import { sIgnite } from "../sounds";

const STAKES = [1, 5, 10, 25, 100];
const DURATIONS = [5, 10, 30, 60];
const PAYOUT = 1.9;

export default function TradeControls() {
  const stake = useStore((s) => s.stake);
  const durationS = useStore((s) => s.durationS);
  const setStake = useStore((s) => s.setStake);
  const setDuration = useStore((s) => s.setDuration);
  const selected = useStore((s) => s.selected);
  const config = useStore((s) => s.config);
  const client = useStore((s) => s.client);
  const user = useStore((s) => s.user);
  const soundOn = useStore((s) => s.soundOn);
  const feeds = useStore((s) => s.feeds);
  const sessions = useStore((s) => s.sessions);
  const { addPending, removePending, setLatency, toast } = useStore.getState();

  const market = config?.markets.find((m) => m.idx === selected);
  const stakeUnits = toUnits(stake);
  const status = market
    ? marketStatusOf(feeds, sessions, market.symbol)
    : { closed: false, reason: null };
  const canTrade =
    !!client &&
    !!market &&
    !!user &&
    !status.closed &&
    user.balance >= stakeUnits &&
    user.openBets < 8;

  const fire = async (direction: number) => {
    if (!client || !market) return;
    const id = crypto.randomUUID();
    addPending({ id, marketIdx: market.idx, direction, stake: stakeUnits, durationS });
    if (soundOn) sIgnite();
    try {
      const { ms } = await client.placeBet(market, direction, stakeUnits, durationS);
      setLatency(ms);
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 140) : "bet failed", "err");
    } finally {
      removePending(id);
    }
  };

  return (
    <footer className="controls">
      <div className="control-group">
        <span className="control-label">Expiry</span>
        <div className="chip-row" role="radiogroup" aria-label="expiry">
          {DURATIONS.map((d) => (
            <button
              key={d}
              className={`chip num ${d === durationS ? "active" : ""}`}
              onClick={() => setDuration(d)}
              role="radio"
              aria-checked={d === durationS}
            >
              {d}s
            </button>
          ))}
        </div>
      </div>

      <div className="control-group">
        <span className="control-label">Stake</span>
        <div className="chip-row" role="radiogroup" aria-label="stake">
          {STAKES.map((v) => (
            <button
              key={v}
              className={`chip num ${v === stake ? "active" : ""}`}
              onClick={() => setStake(v)}
              role="radio"
              aria-checked={v === stake}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="controls-spacer" />

      {status.closed && (
        <div className="closed-note">
          {market?.symbol} market is <strong>{status.reason?.toLowerCase()}</strong>
          <span>opens when the venue reopens</span>
        </div>
      )}

      <button
        className="dir-btn short"
        disabled={!canTrade}
        onClick={() => fire(DIRECTION_DOWN)}
      >
        <span className="arrow">▼</span> SHORT
        <span className="payout num">×{PAYOUT}</span>
      </button>
      <button
        className="dir-btn long"
        disabled={!canTrade}
        onClick={() => fire(DIRECTION_UP)}
      >
        <span className="arrow">▲</span> LONG
        <span className="payout num">×{PAYOUT}</span>
      </button>
    </footer>
  );
}
