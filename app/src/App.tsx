import { useEffect, useRef } from "react";
import { loadChainConfig } from "./chain/config";
import { loadBurner } from "./chain/wallet";
import { WickClient } from "./chain/wick";
import { useStore, openBets } from "./state/store";
import { sWin, sLoss, sPush } from "./sounds";
import TopBar from "./components/TopBar";
import MarketRail from "./components/MarketRail";
import PriceStage from "./components/PriceStage";
import TradeControls from "./components/TradeControls";
import Onboarding from "./components/Onboarding";
import Toasts from "./components/Toasts";
import HouseDesk from "./components/HouseDesk";
import LatencyDuel from "./components/LatencyDuel";
import TrustPanel from "./components/TrustPanel";
import Leaderboard from "./components/Leaderboard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const phase = useStore((s) => s.phase);
  const bootError = useStore((s) => s.bootError);
  const subsRef = useRef<number[]>([]);
  const resolvingRef = useRef<Set<string>>(new Set());
  const armedRef = useRef<Set<string>>(new Set());
  const cranksRef = useRef(true); // disabled after first arm failure on this ER

  // ── boot ────────────────────────────────────────────────────
  useEffect(() => {
    const st = useStore.getState();
    (async () => {
      try {
        const cfg = await loadChainConfig();
        const client = new WickClient(cfg, loadBurner());
        st.setClient(client, cfg);

        // live prices immediately, even before onboarding
        for (const m of cfg.markets) {
          const f = await client.fetchFeed(m).catch(() => null);
          if (f) st.pushPrice(m.symbol, f);
          subsRef.current.push(
            client.subscribeFeed(m, (feed) => useStore.getState().pushPrice(m.symbol, feed))
          );
        }

        if ((await client.isDelegated()) && (await client.fetchUser("er"))) {
          await enterReady();
        } else {
          st.setPhase("onboard");
        }
      } catch (e) {
        st.setPhase("error", e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      const c = useStore.getState().client;
      for (const id of subsRef.current) void c?.er.removeAccountChangeListener(id);
    };
  }, []);

  // ── poll market sessions + the house desk from the daemon ─────
  useEffect(() => {
    const st = useStore.getState();
    const daemon = st.config?.daemon;
    let alive = true;
    const poll = async () => {
      const cfg = useStore.getState().config;
      const base = cfg?.daemon ?? daemon;
      if (!base) return;
      try {
        const [mk, desk] = await Promise.all([
          fetch(`${base}/markets`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${base}/desk`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;
        if (Array.isArray(mk)) useStore.getState().setSessions(mk);
        if (desk && Array.isArray(desk.exposure)) useStore.getState().setDesk(desk);
        // leaderboard is best-effort (getProgramAccounts can be RPC-throttled)
        fetch(`${base}/leaderboard`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((rows) => {
            if (alive && Array.isArray(rows)) useStore.getState().setBoard(rows);
          })
          .catch(() => {});
      } catch {
        /* daemon may be briefly unavailable */
      }
    };
    void poll();
    const iv = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  async function enterReady(): Promise<void> {
    const st = useStore.getState();
    const client = st.client!;
    const user = await client.fetchUser("er");
    st.setUser(user);
    subsRef.current.push(client.subscribeUser((u) => useStore.getState().setUser(u)));
    client.warm();
    st.setPhase("ready");
  }

  // ── auto-resolver: settle expired wicks the moment a print lands ──
  useEffect(() => {
    if (phase !== "ready") return;
    const iv = setInterval(async () => {
      const s = useStore.getState();
      const client = s.client;
      const cfg = s.config;
      if (!client || !cfg) return;
      for (const bet of openBets(s.user)) {
        const market = cfg.markets.find((m) => m.idx === bet.marketIdx);
        const feed = market ? s.feeds[market.symbol] : undefined;
        if (!market || !feed) continue;

        // Best-effort: arm an on-chain crank once per bet so settlement is
        // autonomous even if this client goes away. Disabled after one failure
        // on ERs that don't support user cranks (the resolver below is the path).
        const armKey = `${bet.slot}:${bet.placedMs}`;
        if (cranksRef.current && !armedRef.current.has(armKey)) {
          armedRef.current.add(armKey);
          client.armResolution(market, bet.slot).catch(() => {
            cranksRef.current = false;
          });
        }

        if (feed.tsMs < bet.expiryMs) continue;
        const key = `${bet.slot}:${bet.placedMs}`;
        if (resolvingRef.current.has(key)) continue;
        resolvingRef.current.add(key);
        try {
          const verdict = await client.resolveBet(market, bet.slot);
          if (verdict) {
            s.showVerdict(verdict);
            if (s.soundOn) {
              if (verdict.outcome === "win") sWin();
              else if (verdict.outcome === "loss") sLoss();
              else sPush();
            }
          }
        } catch {
          resolvingRef.current.delete(key); // retry on next print
          return;
        }
        setTimeout(() => resolvingRef.current.delete(key), 4000);
      }
    }, 180);
    return () => clearInterval(iv);
  }, [phase]);

  // ── settle up: undelegate → withdraw everything to the wallet ──
  async function settle(): Promise<void> {
    const s = useStore.getState();
    const client = s.client;
    if (!client) return;
    if (openBets(s.user).length > 0) {
      s.toast("let your open wicks burn out first");
      return;
    }
    s.setBusy(true);
    try {
      await client.undelegateUser();
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (!(await client.isDelegated())) break;
      }
      const user = await client.fetchUser("base");
      if (user && user.balance > 0) await client.withdraw(user.balance);
      s.toast("settled to L1 — funds are in your wallet");
      s.setPhase("onboard");
    } catch (e) {
      s.toast(e instanceof Error ? e.message.slice(0, 140) : "settle failed", "err");
    } finally {
      s.setBusy(false);
    }
  }

  if (phase === "boot") {
    return (
      <div className="onboard">
        <div className="onboard-inner">
          <h1 style={{ opacity: 0.4 }}>Wick</h1>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="onboard">
        <div className="onboard-inner">
          <h1>Wick</h1>
          <p className="tagline">Can't reach the chain.</p>
          <p className="error">{bootError}</p>
        </div>
      </div>
    );
  }

  if (phase === "onboard") {
    return (
      <>
        <Onboarding onReady={enterReady} />
        <TrustPanel />
        <Toasts />
      </>
    );
  }

  return (
    <div className="shell">
      <TopBar onSettle={settle} />
      <MarketRail />
      <PriceStage />
      <TradeControls />
      <HouseDesk />
      <LatencyDuel />
      <TrustPanel />
      <Leaderboard />
      <Toasts />
    </div>
  );
}
