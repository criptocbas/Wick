import { useStore } from "../state/store";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * A live readout of recent rollup confirmation times — placements and
 * settlements both feed it. It's the always-visible proof that real on-chain
 * work is landing in tens of milliseconds, so the ER advantage isn't buried in
 * a modal a judge has to find.
 */
export default function LatencyTape() {
  const latencies = useStore((s) => s.latencies);
  if (latencies.length === 0) return null;
  const med = median(latencies);

  return (
    <div className="lat-tape" title="live rollup confirmation times — placements and settlements">
      <span className="lat-tape-k">rollup</span>
      <div className="lat-bars">
        {latencies.map((ms, i) => (
          <span
            key={i}
            className="lat-bar"
            style={{ height: `${Math.max(3, Math.min(ms / 24, 14))}px` }}
          />
        ))}
      </div>
      <span className="lat-tape-v num">~{med}ms</span>
      <span className="lat-tape-tag">gasless · L1 ≈ 400ms+</span>
    </div>
  );
}
