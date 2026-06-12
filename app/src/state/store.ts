import { create } from "zustand";
import type { ChainConfig, MarketInfo } from "../chain/config";
import type { Bet, FeedState, UserState, Verdict, WickClient } from "../chain/wick";

export interface PricePoint {
  t: number; // feed timestamp ms
  p: number; // ui price
}

export interface PendingBet {
  id: string;
  marketIdx: number;
  direction: number;
  stake: number;
  durationS: number;
  createdAt: number;
}

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "err";
}

export interface MarketSession {
  symbol: string;
  session: string; // "regular" | "preMarket" | "postMarket" | "overNight" | "closed" | …
  trading: boolean;
}

export interface DeskExposure {
  symbol: string;
  longUsd: number;
  shortUsd: number;
  netUsd: number;
}

export interface DeskPosition {
  market: string;
  side: "LONG" | "SHORT";
  sizeUsd: number;
  entryUi: string | null;
  pnlUsd: string | null;
  key: string | null;
}

export interface HouseLedger {
  balanceUsd: number;
  lockedUsd: number;
  lifetimePnlUsd: number;
}

export interface DeskState {
  hedger: string | null;
  house: HouseLedger | null;
  hedgePnlUsd: number;
  exposure: DeskExposure[];
  positions: DeskPosition[];
}

/** A point on the live House-book-vs-Hedge P&L chart, accumulated client-side
 *  from each /desk poll so the risk engine is visible, not just claimed. */
export interface PnlPoint {
  t: number;
  book: number; // house lifetime P&L (the edge)
  hedge: number; // live Flash hedge unrealized P&L
}

export interface LeaderRow {
  wallet: string;
  wins: number;
  losses: number;
  pushes: number;
  streak: number;
  bestStreak: number;
  pnlUsd: number;
  volumeUsd: number;
}

/** A friendly label for a non-trading session. */
export function sessionLabel(session: string): string {
  const s = session.toLowerCase();
  if (s === "closed" || s === "") return "Closed";
  if (s.includes("weekend")) return "Weekend";
  if (s.includes("holiday")) return "Holiday";
  return "Closed";
}

interface WickStore {
  phase: "boot" | "onboard" | "ready" | "error";
  bootError: string | null;
  client: WickClient | null;
  config: ChainConfig | null;

  feeds: Record<string, FeedState>;
  series: Record<string, PricePoint[]>;

  user: UserState | null;
  selected: number;
  stake: number; // ui units
  durationS: number;
  pending: PendingBet[];
  verdict: (Verdict & { id: string; settleMs?: number }) | null;
  lastLatency: number | null;
  /** Rolling recent ER confirmation times (placements + settlements) — the
   *  always-visible proof the rollup is doing real work in tens of ms. */
  latencies: number[];
  soundOn: boolean;
  toasts: Toast[];
  busy: boolean;

  sessions: Record<string, MarketSession>;
  desk: DeskState | null;
  pnlSeries: PnlPoint[];
  deskOpen: boolean;
  /** Shared latency-duel result so the ambient strip and the modal stay in sync. */
  duel: { er: number | null; l1: number | null; running: boolean };
  duelOpen: boolean;
  trustOpen: boolean;
  boardOpen: boolean;
  board: LeaderRow[];

  setPhase(p: WickStore["phase"], err?: string): void;
  setClient(c: WickClient, cfg: ChainConfig): void;
  pushPrice(symbol: string, f: FeedState): void;
  setUser(u: UserState | null): void;
  select(idx: number): void;
  setStake(v: number): void;
  setDuration(v: number): void;
  addPending(p: PendingBet): void;
  removePending(id: string): void;
  showVerdict(v: Verdict, settleMs?: number): void;
  clearVerdict(): void;
  recordLatency(ms: number): void;
  toggleSound(): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dropToast(id: string): void;
  setBusy(b: boolean): void;
  setSessions(s: MarketSession[]): void;
  setDesk(d: DeskState | null): void;
  toggleDesk(open?: boolean): void;
  /** Race the same tx on the ER and on Solana L1; updates `duel` live. */
  runDuel(): Promise<void>;
  toggleDuel(open?: boolean): void;
  toggleTrust(open?: boolean): void;
  toggleBoard(open?: boolean): void;
  setBoard(rows: LeaderRow[]): void;
}

const WINDOW_MS = 95_000;
/** A market whose feed lags the freshest (always-live crypto) feed by more than
 *  this is treated as closed — a dead/frozen print. Independent of the program's
 *  placement-staleness guard (max_feed_age_ms, ~2.5s); this is generous on
 *  purpose so brief network hiccups don't flap a live market to "closed". */
const STALE_MS = 13_000;

export const useStore = create<WickStore>((set, get) => ({
  phase: "boot",
  bootError: null,
  client: null,
  config: null,
  feeds: {},
  series: {},
  user: null,
  selected: 0,
  stake: 10,
  durationS: 10,
  pending: [],
  verdict: null,
  lastLatency: null,
  latencies: [],
  soundOn: localStorage.getItem("wick:sound") !== "off",
  toasts: [],
  busy: false,
  sessions: {},
  desk: null,
  pnlSeries: [],
  deskOpen: false,
  duel: { er: null, l1: null, running: false },
  duelOpen: false,
  trustOpen: false,
  boardOpen: false,
  board: [],

  setPhase: (phase, err) => set({ phase, bootError: err ?? null }),
  setClient: (client, config) => set({ client, config }),

  pushPrice: (symbol, f) =>
    set((s) => {
      const cur = s.feeds[symbol];
      // Out-of-order websocket delivery: never let an older print regress state.
      if (cur && f.tsMs < cur.tsMs) return {};
      // Duplicate notification of the same print: refresh the readout only.
      if (cur && f.tsMs === cur.tsMs && f.price === cur.price) {
        return { feeds: { ...s.feeds, [symbol]: f } };
      }
      const prev = s.series[symbol] ?? [];
      const last = prev[prev.length - 1];
      // Oracle publish times are second-truncated; synthesize monotonic
      // sub-second x so every intra-second print still renders, in order.
      let t = f.tsMs;
      if (last) {
        t = Math.min(Math.max(f.tsMs, last.t + 120), f.tsMs + 980);
        if (t <= last.t) t = last.t + 1;
      }
      const cutoff = t - WINDOW_MS;
      const next = [...prev.filter((pt) => pt.t >= cutoff), { t, p: f.price }];
      return {
        feeds: { ...s.feeds, [symbol]: f },
        series: { ...s.series, [symbol]: next },
      };
    }),

  setUser: (user) => set({ user }),
  select: (selected) => set({ selected }),
  setStake: (stake) => set({ stake }),
  setDuration: (durationS) => set({ durationS }),
  addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
  removePending: (id) =>
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),

  showVerdict: (v, settleMs) =>
    set({ verdict: { ...v, id: crypto.randomUUID(), settleMs } }),
  clearVerdict: () => set({ verdict: null }),
  recordLatency: (ms) =>
    set((s) => ({ lastLatency: ms, latencies: [...s.latencies.slice(-7), ms] })),

  toggleSound: () => {
    const next = !get().soundOn;
    localStorage.setItem("wick:sound", next ? "on" : "off");
    set({ soundOn: next });
  },

  toast: (text, kind = "info") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
    setTimeout(() => get().dropToast(id), 4200);
  },
  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setBusy: (busy) => set({ busy }),
  setSessions: (list) =>
    set({ sessions: Object.fromEntries(list.map((s) => [s.symbol, s])) }),
  setDesk: (desk) =>
    set((s) => {
      if (!desk?.house) return { desk };
      const last = s.pnlSeries[s.pnlSeries.length - 1];
      const point: PnlPoint = {
        t: Date.now(),
        book: desk.house.lifetimePnlUsd,
        hedge: desk.hedgePnlUsd,
      };
      // only append when something actually moved, cap the window
      const changed =
        !last || last.book !== point.book || last.hedge !== point.hedge;
      const pnlSeries = changed
        ? [...s.pnlSeries.slice(-179), point]
        : s.pnlSeries;
      return { desk, pnlSeries };
    }),
  toggleDesk: (open) => set((s) => ({ deskOpen: open ?? !s.deskOpen })),
  runDuel: async () => {
    const { client, duel } = get();
    if (!client || duel.running) return;
    set({ duel: { er: null, l1: null, running: true } });
    try {
      await client.latencyDuel({
        onEr: (ms) => set((s) => ({ duel: { ...s.duel, er: ms } })),
        onL1: (ms) => set((s) => ({ duel: { ...s.duel, l1: ms } })),
      });
    } catch {
      /* whatever lane landed stays shown */
    } finally {
      set((s) => ({ duel: { ...s.duel, running: false } }));
    }
  },
  toggleDuel: (open) => set((s) => ({ duelOpen: open ?? !s.duelOpen })),
  toggleTrust: (open) => set((s) => ({ trustOpen: open ?? !s.trustOpen })),
  toggleBoard: (open) => set((s) => ({ boardOpen: open ?? !s.boardOpen })),
  setBoard: (board) => set({ board }),
}));

export function openBets(user: UserState | null): Bet[] {
  return user?.bets.filter((b) => b.status === 1) ?? [];
}

export function marketBySymbol(cfg: ChainConfig | null, idx: number): MarketInfo | null {
  return cfg?.markets.find((m) => m.idx === idx) ?? null;
}

/** The freshest feed timestamp across all markets — the always-live crypto feeds
 *  give us an effective chain clock without trusting the browser's wall clock. */
export function freshestTs(feeds: Record<string, FeedState>): number {
  let max = 0;
  for (const f of Object.values(feeds)) if (f.tsMs > max) max = f.tsMs;
  return max;
}

export interface MarketStatus {
  closed: boolean;
  reason: string | null; // friendly label when closed
}

/** A market is closed if its session says so OR its feed has gone stale relative
 *  to the freshest feed (mirrors the program's on-chain max-feed-age guard).
 *  Pure: pass the store maps so React components re-derive on change. */
export function marketStatusOf(
  feeds: Record<string, FeedState>,
  sessions: Record<string, MarketSession>,
  symbol: string
): MarketStatus {
  const feed = feeds[symbol];
  const session = sessions[symbol];
  if (session && !session.trading) {
    return { closed: true, reason: sessionLabel(session.session) };
  }
  if (feed && freshestTs(feeds) - feed.tsMs > STALE_MS) {
    return { closed: true, reason: session ? sessionLabel(session.session) : "Closed" };
  }
  return { closed: false, reason: null };
}
