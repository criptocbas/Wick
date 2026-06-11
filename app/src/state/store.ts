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
}

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "err";
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
  verdict: (Verdict & { id: string }) | null;
  lastLatency: number | null;
  soundOn: boolean;
  toasts: Toast[];
  busy: boolean;

  setPhase(p: WickStore["phase"], err?: string): void;
  setClient(c: WickClient, cfg: ChainConfig): void;
  pushPrice(symbol: string, f: FeedState): void;
  setUser(u: UserState | null): void;
  select(idx: number): void;
  setStake(v: number): void;
  setDuration(v: number): void;
  addPending(p: PendingBet): void;
  removePending(id: string): void;
  showVerdict(v: Verdict): void;
  clearVerdict(): void;
  setLatency(ms: number): void;
  toggleSound(): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dropToast(id: string): void;
  setBusy(b: boolean): void;
}

const WINDOW_MS = 95_000;

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
  soundOn: localStorage.getItem("wick:sound") !== "off",
  toasts: [],
  busy: false,

  setPhase: (phase, err) => set({ phase, bootError: err ?? null }),
  setClient: (client, config) => set({ client, config }),

  pushPrice: (symbol, f) =>
    set((s) => {
      const prev = s.series[symbol] ?? [];
      const last = prev[prev.length - 1];
      if (last && last.t === f.tsMs) return { feeds: { ...s.feeds, [symbol]: f } };
      const cutoff = f.tsMs - WINDOW_MS;
      const next = [...prev.filter((pt) => pt.t >= cutoff), { t: f.tsMs, p: f.price }];
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

  showVerdict: (v) => set({ verdict: { ...v, id: crypto.randomUUID() } }),
  clearVerdict: () => set({ verdict: null }),
  setLatency: (lastLatency) => set({ lastLatency }),

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
}));

export function openBets(user: UserState | null): Bet[] {
  return user?.bets.filter((b) => b.status === 1) ?? [];
}

export function marketBySymbol(cfg: ChainConfig | null, idx: number): MarketInfo | null {
  return cfg?.markets.find((m) => m.idx === idx) ?? null;
}
