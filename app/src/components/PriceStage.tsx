import { useEffect, useRef } from "react";
import { useStore, openBets } from "../state/store";
import { splitPrice } from "../util";
import { DIRECTION_UP } from "../chain/wick";
import { WickStrips } from "./WickStrip";
import { VerdictOverlay } from "./Verdict";

const WINDOW_MS = 60_000;
const RIGHT_PAD_FRAC = 0.07;

/** Full-bleed canvas price tape: cream line, amber head, strike lines for live bets. */
export default function PriceStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = useStore((s) => s.selected);
  const config = useStore((s) => s.config);
  const feed = useStore((s) => s.feeds[config?.markets[selected]?.symbol ?? ""]);
  const market = config?.markets.find((m) => m.idx === selected);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    // smoothed scale state
    let yMin = 0;
    let yMax = 1;
    let initialized = false;

    const ro = new ResizeObserver(() => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    });
    ro.observe(canvas);

    const css = getComputedStyle(document.documentElement);
    const C = {
      line: `oklch(93% 0.022 85)`,
      grid: `oklch(93% 0.022 85 / 0.05)`,
      label: `oklch(47% 0.018 75)`,
      flame: css.getPropertyValue("--flame").trim() || "#e8a33d",
      up: css.getPropertyValue("--up").trim(),
      down: css.getPropertyValue("--down").trim(),
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useStore.getState();
      const cfg = s.config;
      if (!cfg || w === 0) return;
      const mkt = cfg.markets.find((m) => m.idx === s.selected);
      if (!mkt) return;
      const pts = s.series[mkt.symbol] ?? [];
      const live = s.feeds[mkt.symbol];

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (pts.length < 2 || !live) return;

      const tRight = live.tsMs;
      const tLeft = tRight - WINDOW_MS;
      const plotW = w * (1 - RIGHT_PAD_FRAC);

      // scale with padding, smoothed toward target
      const visible = pts.filter((p) => p.t >= tLeft);
      const bets = openBets(s.user).filter((b) => b.marketIdx === mkt.idx);
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of visible) {
        if (p.p < lo) lo = p.p;
        if (p.p > hi) hi = p.p;
      }
      for (const b of bets) {
        const strike = b.strike * 10 ** b.expo;
        if (strike < lo) lo = strike;
        if (strike > hi) hi = strike;
      }
      if (!isFinite(lo)) return;
      const pad = Math.max((hi - lo) * 0.18, hi * 0.0004);
      const targetMin = lo - pad;
      const targetMax = hi + pad;
      if (!initialized) {
        yMin = targetMin;
        yMax = targetMax;
        initialized = true;
      } else {
        yMin += (targetMin - yMin) * 0.12;
        yMax += (targetMax - yMax) * 0.12;
      }

      const X = (t: number) => ((t - tLeft) / WINDOW_MS) * plotW;
      const Y = (p: number) => h - ((p - yMin) / (yMax - yMin)) * h;

      // grid + labels
      ctx.font = "11px Archivo Variable, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 1; i <= 4; i++) {
        const p = yMin + ((yMax - yMin) * i) / 5;
        const y = Y(p);
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillStyle = C.label;
        ctx.fillText(p.toFixed(mkt.display), w - 8, y - 1);
      }

      // strike lines + win zones
      for (const b of bets) {
        const strike = b.strike * 10 ** b.expo;
        const y = Y(strike);
        const isUp = b.direction === DIRECTION_UP;
        const col = isUp ? C.up : C.down;

        // soft win-zone tint from strike toward direction
        const zone = ctx.createLinearGradient(0, y, 0, isUp ? Math.max(y - 90, 0) : Math.min(y + 90, h));
        zone.addColorStop(0, `${isUp ? "oklch(74% 0.145 152" : "oklch(63% 0.185 29"} / 0.07)`);
        zone.addColorStop(1, `${isUp ? "oklch(74% 0.145 152" : "oklch(63% 0.185 29"} / 0)`);
        ctx.fillStyle = zone;
        ctx.fillRect(0, isUp ? y - 90 : y, w, 90);

        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // expiry tick
        const xE = X(b.expiryMs);
        if (xE > 0 && xE < w) {
          ctx.strokeStyle = `oklch(80% 0.14 75 / 0.55)`;
          ctx.beginPath();
          ctx.moveTo(xE, y - 14);
          ctx.lineTo(xE, y + 14);
          ctx.stroke();
        }
      }

      // the price line
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const x = X(p.t);
        const y = Y(p.p);
        if (x < -10) continue;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // amber head with breathing halo (candlelight, restrained)
      const hx = X(tRight);
      const hy = Y(live.price);
      const pulse = 1 + 0.18 * Math.sin(performance.now() / 320);
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 14 * pulse);
      halo.addColorStop(0, "oklch(80% 0.14 75 / 0.32)");
      halo.addColorStop(1, "oklch(80% 0.14 75 / 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, 14 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.flame;
      ctx.beginPath();
      ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const [int, frac] = feed ? splitPrice(feed.price, market?.display ?? 2) : ["—", ""];

  return (
    <section className="stage" aria-label="price chart">
      <canvas ref={canvasRef} />
      <div className="stage-readout">
        <div className="sym">{market?.symbol ?? ""} / USD</div>
        <div className="price num">
          {int}
          <span className="frac">{frac}</span>
        </div>
      </div>
      <WickStrips />
      <VerdictOverlay />
    </section>
  );
}
