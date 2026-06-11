/** Tiny synthesized sound design — a match strike, a chime, a soft thud. */

let ctx: AudioContext | null = null;

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  when = 0
): void {
  const c = ac();
  const t = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur);
}

/** match-strike: a short filtered noise burst */
export function sIgnite(): void {
  const c = ac();
  const t = c.currentTime;
  const len = 0.09;
  const buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 2600;
  f.Q.value = 0.9;
  const g = c.createGain();
  g.gain.value = 0.16;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
}

export function sWin(): void {
  tone(660, 0.16, "sine", 0.14);
  tone(990, 0.3, "sine", 0.12, 0.07);
}

export function sLoss(): void {
  tone(150, 0.22, "sine", 0.13);
  tone(98, 0.3, "sine", 0.1, 0.05);
}

export function sPush(): void {
  tone(440, 0.18, "sine", 0.1);
}
