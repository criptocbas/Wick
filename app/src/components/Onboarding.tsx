import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { toUnits } from "../chain/config";
import { resetBurner } from "../chain/wallet";

type StepId = "fund" | "open" | "deposit" | "delegate";

const STEP_LABELS: Record<StepId, string> = {
  fund: "Fund your burner from the faucet",
  open: "Open your Wick account",
  deposit: "Deposit 1,000 wUSDC into escrow",
  delegate: "Delegate to the ephemeral rollup",
};

const STEP_HINTS: Record<StepId, string> = {
  fund: "minting demo wUSDC to a fresh browser wallet…",
  open: "creating your on-chain account…",
  deposit: "moving collateral into the L1 escrow vault…",
  delegate: "handing execution to the rollup — custody stays on L1…",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Onboarding({ onReady }: { onReady: () => Promise<void> }) {
  const client = useStore((s) => s.client);
  const config = useStore((s) => s.config);
  const toggleTrust = useStore((s) => s.toggleTrust);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<Set<StepId>>(new Set());
  const [now, setNow] = useState<StepId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // a live elapsed counter so the wait never reads as "frozen"
  useEffect(() => {
    if (!running) return;
    const t0 = performance.now();
    const iv = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => clearInterval(iv);
  }, [running]);

  const run = async () => {
    if (!client || !config) return;
    setRunning(true);
    setError(null);
    setElapsed(0);
    try {
      const mark = (id: StepId) => setDone((d) => new Set(d).add(id));

      setNow("fund");
      // Top up unless the burner already holds a usable balance. A returning
      // burner may have an empty/partial token account under the current mint.
      if ((await client.tokenBalance()) < 100) {
        const res = await fetch(`${config.daemon}/faucet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: client.wallet.publicKey.toBase58() }),
        });
        if (res.ok) {
          await client.waitForFunding();
        } else if ((await client.tokenBalance()) < 1) {
          // faucet refused (e.g. per-wallet cooldown) AND we have nothing to trade
          throw new Error(`faucet: ${(await res.text()).slice(0, 90)}`);
        }
        // else: faucet refused but the burner already has some balance — proceed
      }
      mark("fund");

      setNow("open");
      if (!(await client.userExists())) await client.initUser();
      // the account may lag the init confirmation on RPC — wait for it
      let user = await client.fetchUser("base");
      for (let i = 0; i < 10 && !user; i++) {
        await sleep(600);
        user = await client.fetchUser("base");
      }
      mark("open");

      setNow("deposit");
      // deposit unless the account is already funded (idempotent re-runs). Deposit
      // exactly what the wallet holds (capped) so a partial balance can never fail
      // the SPL transfer with InsufficientFunds.
      if (!user || user.balance < toUnits(1)) {
        const have = await client.tokenBalanceUnits();
        const amount = Math.min(have, toUnits(1000));
        if (amount <= 0) {
          throw new Error('wallet has no wUSDC — tap "start fresh" below');
        }
        await client.deposit(amount);
      }
      mark("deposit");

      setNow("delegate");
      if (!(await client.isDelegated())) {
        await client.delegateUser();
      }
      // wait for the delegation to actually land in the rollup before trading
      await client.waitUntilTradeReady();
      mark("delegate");

      setNow(null);
      await onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 220) : String(e));
      setRunning(false);
      setNow(null);
    }
  };

  return (
    <div className="onboard">
      <div className="onboard-inner">
        <h1>
          W<span style={{ position: "relative" }}>ı<span style={{
            position: "absolute", top: "0.14em", left: "0.08em",
            width: "0.15em", height: "0.2em", borderRadius: "50% 50% 50% 50% / 62% 62% 38% 38%",
            background: "var(--flame)",
          }} /></span>ck
        </h1>
        <p className="tagline">
          Ten seconds. One direction. No liquidations.
          <br />
          Options that settle before you blink — custody never leaves Solana.
        </p>

        {(Object.keys(STEP_LABELS) as StepId[]).map((id) => (
          <div
            key={id}
            className={`step ${done.has(id) ? "done" : ""} ${now === id ? "now" : ""}`}
          >
            <span className="dot" />
            <span className="step-body">
              {STEP_LABELS[id]}
              {now === id && <span className="step-hint">{STEP_HINTS[id]}</span>}
            </span>
            {done.has(id) && <span className="step-check">✓</span>}
          </div>
        ))}

        <button className="btn-flame" onClick={run} disabled={running}>
          {running ? (
            <>
              Lighting… <span className="num">{elapsed.toFixed(0)}s</span>
            </>
          ) : (
            "Light the wick"
          )}
        </button>
        <p className="fine">
          {running
            ? "~30s — every step is a real on-chain transaction, no popups, all gasless on the rollup."
            : "One click sets up a local burner wallet — no extension, no popups, every trade gasless on the rollup."}
        </p>
        <button className="trust-trigger" onClick={() => toggleTrust(true)}>
          Provably fair — why your money is safe ↗
        </button>
        {error && (
          <>
            <p className="error">
              Couldn't finish setup — {error}. Tap “Light the wick” to retry.
            </p>
            <button className="reset-burner" onClick={resetBurner} disabled={running}>
              …or start fresh with a new burner wallet
            </button>
          </>
        )}
      </div>
    </div>
  );
}
