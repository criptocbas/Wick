import { marketStatusOf, useStore } from "../state/store";
import { toUnits } from "../chain/config";
import {
  DIRECTION_DOWN,
  DIRECTION_UP,
  BET_KIND_BINARY,
  BET_KIND_TOUCH,
  TOUCH_BARRIERS,
} from "../chain/wick";
import { sIgnite } from "../sounds";

const STAKES = [1, 5, 10, 25, 100];
const DURATIONS = [5, 10, 30, 60];
const BINARY_PAYOUT = 1.9;

export default function TradeControls() {
  const stake = useStore((s) => s.stake);
  const durationS = useStore((s) => s.durationS);
  const setStake = useStore((s) => s.setStake);
  const setDuration = useStore((s) => s.setDuration);
  const betKind = useStore((s) => s.betKind);
  const barrierBps = useStore((s) => s.barrierBps);
  const setBetKind = useStore((s) => s.setBetKind);
  const setBarrierBps = useStore((s) => s.setBarrierBps);
  const selected = useStore((s) => s.selected);
  const config = useStore((s) => s.config);
  const client = useStore((s) => s.client);
  const user = useStore((s) => s.user);
  const soundOn = useStore((s) => s.soundOn);
  const feeds = useStore((s) => s.feeds);
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const { addPending, removePending, recordLatency, toast } = useStore.getState();

  const isTouch = betKind === BET_KIND_TOUCH;
  const barrier = TOUCH_BARRIERS.find((b) => b.bps === barrierBps) ?? TOUCH_BARRIERS[1];
  const payoutX = isTouch ? barrier.payoutX : BINARY_PAYOUT;

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
  const showHint =
    canTrade && !status.closed && (user?.openBets ?? 0) === 0 && pending.length === 0;

  const fire = async (direction: number) => {
    if (!client || !market) return;
    const id = crypto.randomUUID();
    addPending({
      id,
      marketIdx: market.idx,
      direction,
      stake: stakeUnits,
      durationS,
      createdAt: Date.now(),
    });
    if (soundOn) sIgnite();
    try {
      const { ms } = isTouch
        ? await client.placeTouchBet(market, direction, stakeUnits, durationS, barrierBps)
        : await client.placeBet(market, direction, stakeUnits, durationS);
      recordLatency(ms);
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 140) : "bet failed", "err");
    } finally {
      removePending(id);
    }
  };

  return (
    <footer className="controls">
      <div className="control-group">
        <span className="control-label">Mode</span>
        <div className="chip-row" role="radiogroup" aria-label="bet type">
          <button
            className={`chip ${!isTouch ? "active" : ""}`}
            onClick={() => setBetKind(BET_KIND_BINARY)}
            role="radio"
            aria-checked={!isTouch}
            title="settle up/down against the price at expiry"
          >
            Settle
          </button>
          <button
            className={`chip ${isTouch ? "active" : ""}`}
            onClick={() => setBetKind(BET_KIND_TOUCH)}
            role="radio"
            aria-checked={isTouch}
            title="win the instant the price touches a barrier — monitored live on the rollup"
          >
            Touch
          </button>
        </div>
      </div>

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

      {isTouch && (
        <div className="control-group">
          <span className="control-label">Barrier</span>
          <div className="chip-row" role="radiogroup" aria-label="barrier distance">
            {TOUCH_BARRIERS.map((b) => (
              <button
                key={b.bps}
                className={`chip num ${b.bps === barrierBps ? "active" : ""}`}
                onClick={() => setBarrierBps(b.bps)}
                role="radio"
                aria-checked={b.bps === barrierBps}
                title={`${b.label} away · pays ${b.payoutX}×`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="controls-spacer" />

      {status.closed && (
        <div className="closed-note">
          {market?.symbol} market is <strong>{status.reason?.toLowerCase()}</strong>
          <span>opens when the venue reopens</span>
        </div>
      )}

      {showHint && (
        <div className="first-tap-hint">
          {isTouch ? (
            <>
              Tap a side — you win the instant {market?.symbol} <strong>touches</strong>{" "}
              {barrier.label} away
            </>
          ) : (
            <>
              Tap <strong className="up">LONG</strong> or <strong className="down">SHORT</strong>{" "}
              to place your first {durationS}-second option
            </>
          )}
        </div>
      )}

      <button
        className="dir-btn short"
        disabled={!canTrade}
        onClick={() => fire(DIRECTION_DOWN)}
      >
        <span className="arrow">▼</span> {isTouch ? "TOUCH DOWN" : "SHORT"}
        <span className="payout num">×{payoutX}</span>
      </button>
      <button
        className="dir-btn long"
        disabled={!canTrade}
        onClick={() => fire(DIRECTION_UP)}
      >
        <span className="arrow">▲</span> {isTouch ? "TOUCH UP" : "LONG"}
        <span className="payout num">×{payoutX}</span>
      </button>
    </footer>
  );
}
