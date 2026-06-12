import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { fmtMoney } from "../util";

const WORDS = { win: "Lit.", loss: "Snuffed.", push: "Push." } as const;

export function VerdictOverlay() {
  const verdict = useStore((s) => s.verdict);
  const clear = useStore((s) => s.clearVerdict);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!verdict) return;
    setFading(false);
    const t1 = setTimeout(() => setFading(true), 1300);
    const t2 = setTimeout(clear, 1900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [verdict?.id]);

  if (!verdict) return null;

  return (
    <div className="verdict" aria-live="polite">
      <div className={`verdict-card ${verdict.outcome} ${fading ? "fading" : ""}`}>
        <div className="word">{WORDS[verdict.outcome]}</div>
        <div className="amount num">
          {verdict.outcome === "win" && `+${fmtMoney(verdict.payout - verdict.stake)}`}
          {verdict.outcome === "loss" && `−${fmtMoney(verdict.stake)}`}
          {verdict.outcome === "push" && "stake returned"}
        </div>
        {verdict.settleMs != null && (
          <div className="verdict-settle num">
            settled in <strong>{verdict.settleMs}ms</strong> on the rollup
          </div>
        )}
      </div>
    </div>
  );
}
