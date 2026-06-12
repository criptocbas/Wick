import { useStore } from "../state/store";

/**
 * "Why it's fair" — the panel that separates Wick from every offshore binary
 * options site. Each claim is backed by an on-chain account a judge can open.
 */
export default function TrustPanel() {
  const open = useStore((s) => s.trustOpen);
  const toggle = useStore((s) => s.toggleTrust);
  const client = useStore((s) => s.client);
  const desk = useStore((s) => s.desk);
  if (!open) return null;

  const link = (addr: string | undefined, label: string) =>
    addr && client ? (
      <a className="trust-link" href={client.solscan(addr)} target="_blank" rel="noreferrer">
        {label} ↗
      </a>
    ) : (
      <span className="trust-link muted">{label}</span>
    );

  const rows: { k: string; title: string; body: React.ReactNode }[] = [
    {
      k: "custody",
      title: "Your collateral never leaves Solana",
      body: (
        <>
          Deposits sit in an L1 escrow vault, not our wallet. We only delegate the
          execution state to the rollup.{" "}
          {link(client?.vaultPda.toBase58(), "Open the escrow vault")}
        </>
      ),
    },
    {
      k: "prices",
      title: "Prices are an institutional feed, not ours to shade",
      body: (
        <>
          SOL / BTC / ETH settle against MagicBlock's <strong>Pyth Lazer</strong> oracle.
          NVDA / gold / EUR stream from <strong>Flash Trade</strong>. We can't move the
          print a winning trade settles on.
        </>
      ),
    },
    {
      k: "hedge",
      title: "The house is hedged, not gambling against you",
      body: (
        <>
          Net trader exposure is offset with real perpetuals on Flash Trade mainnet, so
          the house runs delta-neutral and earns the published edge.{" "}
          {desk?.hedger ? link(desk.hedger, "Watch the hedge wallet") : <span className="trust-link muted">hedge desk</span>}
        </>
      ),
    },
    {
      k: "edge",
      title: "The edge is one published number",
      body: (
        <>
          A win returns <strong>1.9×</strong> your stake. No hidden spread, no feed
          manipulation — the ~5% house edge is in the open and the same for everyone.
        </>
      ),
    },
    {
      k: "settle",
      title: "Settlement is autonomous and permissionless",
      body: (
        <>
          Each bet's resolution is scheduled on-chain at placement (a MagicBlock crank) and
          can be settled by anyone against the live oracle — no privileged keeper to stall
          or cherry-pick your payout.
        </>
      ),
    },
    {
      k: "exit",
      title: "You can always walk away with your money",
      body: (
        <>
          Settling undelegates your account back to L1 and withdraws to your wallet — a
          permissionless path that works even if every Wick server disappears.
        </>
      ),
    },
  ];

  return (
    <div className="trust-scrim" onClick={() => toggle(false)}>
      <div className="trust-card" onClick={(e) => e.stopPropagation()}>
        <header className="trust-head">
          <div>
            <div className="trust-title">Provably fair</div>
            <div className="trust-sub">every claim opens an on-chain account</div>
          </div>
          <button className="desk-close" onClick={() => toggle(false)} aria-label="close">
            ✕
          </button>
        </header>
        <div className="trust-rows">
          {rows.map((r) => (
            <div key={r.k} className="trust-row">
              <span className="trust-check">✓</span>
              <div>
                <div className="trust-row-title">{r.title}</div>
                <div className="trust-row-body">{r.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="trust-foot">
          The offshore binary sites that already do 10-second options control the price feed
          and the cashout button. Wick can't — that's the whole point.
        </div>
      </div>
    </div>
  );
}
