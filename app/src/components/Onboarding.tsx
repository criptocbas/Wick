import { useState } from "react";
import { useStore } from "../state/store";
import { toUnits } from "../chain/config";

type StepId = "fund" | "open" | "deposit" | "delegate";

const STEP_LABELS: Record<StepId, string> = {
  fund: "Fund your burner from the faucet",
  open: "Open your Wick account",
  deposit: "Deposit 1,000 wUSDC into escrow",
  delegate: "Delegate to the ephemeral rollup",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Onboarding({ onReady }: { onReady: () => Promise<void> }) {
  const client = useStore((s) => s.client);
  const config = useStore((s) => s.config);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<Set<StepId>>(new Set());
  const [now, setNow] = useState<StepId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!client || !config) return;
    setRunning(true);
    setError(null);
    try {
      const mark = (id: StepId) => setDone((d) => new Set(d).add(id));

      setNow("fund");
      if ((await client.tokenBalance()) < 1) {
        const res = await fetch(`${config.daemon}/faucet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: client.wallet.publicKey.toBase58() }),
        });
        if (!res.ok) throw new Error(`faucet: ${await res.text()}`);
        // wait for the wUSDC to actually land before depositing
        if (!(await client.waitForFunding())) {
          throw new Error("faucet funds did not arrive — try again");
        }
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
      // deposit unless the account is already funded (idempotent re-runs)
      if (!user || user.balance < toUnits(1)) {
        await client.deposit(toUnits(1000));
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
            {STEP_LABELS[id]}
          </div>
        ))}

        <button className="btn-flame" onClick={run} disabled={running}>
          {running ? "Lighting…" : "Light the wick"}
        </button>
        <p className="fine">
          One click sets up a local burner wallet — no extension, no popups, every
          trade gasless on the rollup.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
