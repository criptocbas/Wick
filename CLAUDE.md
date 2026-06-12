# CLAUDE.md — Wick

**Wick** — ten-second options. Ultra-short-dated (5–60s) binary options on a **MagicBlock
Ephemeral Rollup**, hedged on **Flash Trade**. Tap long/short, gasless sub-second confirmation,
settles against a live oracle the moment the clock hits zero. Custody never leaves Solana L1.

Built for **Solana Blitz v5 — "Trading"** (Jun 12–14, 2026). Judged on creativity · technical
depth · meaningful ER use; +50% prize with Flash Trade integrated.

## Layout

```
program/   Anchor 1.0.2 program (ephemeral-rollups-sdk 0.14.x). Escrowed balances, per-market
           books, house solvency reserve, WINDOWED oracle settlement ([expiry, expiry+grace]),
           ONE-TOUCH barrier options (place_touch_bet + check_touch — continuous in-window
           monitoring, the impossible-on-L1 mechanic), void_bet (dead-feed stake refund),
           set_params/set_market_enabled (admin tuning+pause), oracle-program owner check on
           kind-0 feeds, delegate→trade→commit→undelegate, arm_resolution (best-effort crank).
           Devnet id G6Biewd4imM1depq2WpJNomAhM63Y6DVjNYsZWHnAWdi
app/       Vite + React + TS. Tap-to-trade, burning-wick timer, canvas price tape, hedge-desk
           drawer, latency duel, "Provably fair" trust panel, streak leaderboard. Talks to L1 +
           the ER via @coral-xyz/anchor 0.32.1 (the npm TS client never went 1.0).
keepers/   TS services: setup.ts (one-shot protocol bootstrap → app/public/chain-config.json),
           daemon.ts (gasless ER price pusher + permissionless SETTLEMENT SWEEPER + rate-limited
           faucet + /markets /desk /leaderboard read APIs), hedger.ts (reads ER book exposure →
           real Flash V1 mainnet perps; DRY_RUN by default).
```

## Architecture in one paragraph

Custody stays in an **L1 USDC escrow vault**; only the execution state (balances, books, price
feeds) is **delegated** into the ER, where bets are placed and settled at ~50ms for zero fees,
then committed/undelegated back to L1 to withdraw. SOL/BTC/ETH read MagicBlock's **Pyth Lazer**
oracle directly on the ER; NVDA/gold/EUR are pushed from **Flash Trade** `/v2/prices` by the
daemon. The house offsets net trader exposure with **real Flash Trade perps on mainnet** (a real
hedge desk — directional, not a fully delta/gamma-neutral book). Settlement is permissionless
and **windowed** (`[expiry, expiry+grace]`, so timing can't be cherry-picked); it runs three ways
— the bettor's browser, the daemon's permissionless **sweeper**, and an on-chain **crank** where
the ER supports it. A dead feed is `void_bet`-refundable, so funds are never stranded.

## Run it

Toolchain: Solana 3.1.9 · Rust 1.89+ · Anchor 1.0.2 · Node 24+. `anchor` must resolve to 1.0.2.

**Devnet (the demo target):**
```bash
cd program && anchor build && solana program deploy target/deploy/wick.so \
  --program-id target/deploy/wick-keypair.json --url devnet --with-compute-unit-price 120000
cd ../keepers && npm i && CLUSTER=devnet npm run setup          # writes app/public/chain-config.json
CLUSTER=devnet PRICE_SOURCE=flash npm run daemon                # price pusher + faucet + read APIs
cd ../app && npm i && npm run dev                               # http://localhost:5173
```

**Localnet (everything works incl. the crank):** `mb-test-validator --reset` (base :8899), deploy,
then run the ER validator with `--no-tui` and an fd-limit shim (it wants 1M fds):
```bash
printf 'int setrlimit(int r,const void*l){return 0;}' >/tmp/norlimit.c && gcc -shared -fPIC -o /tmp/norlimit.so /tmp/norlimit.c
LD_PRELOAD=/tmp/norlimit.so ephemeral-validator --no-tui --lifecycle ephemeral \
  --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 --listen 127.0.0.1:7799 --reset
CLUSTER=localnet npm run setup && CLUSTER=localnet PRICE_SOURCE=synthetic npm run daemon
```

**Arm the live hedger** (real Flash mainnet positions): fund a keypair with ~$40 USDC + 0.01 SOL,
then `cd keepers && HEDGER_KEYPAIR=… CLUSTER=devnet DRY_RUN=0 npm run hedger`. It caps notional,
auto-flattens on Ctrl-C, and reclaims empty-ATA rent. `npm run hedger -- flatten` / `-- recover`.

## ⚠️ Gotchas that cost hours (don't relearn them)

- **After ANY program rebuild, `cp program/target/idl/wick.json app/src/chain/idl/`.** A stale IDL
  points the app at the OLD program → deposits fail Anchor **ConstraintTokenMint (2014)**, balance
  stays 0, no obvious error.
- **The devnet ER caches cloned bytecode** and may not re-clone an in-place upgrade to the same id.
  If a deploy "doesn't take" on the ER, deploy under a **fresh program id** (then `setup` again).
- **Delegation is racy:** the first ER write after `delegate` can fail `InvalidWritableAccount`.
  The client waits for the rollup to actually have the account and retries — keep that.
- **Check `confirmTransaction(...).value.err`** on L1 sends; the 1-arg form hides failures.
- ER txs use `skipPreflight: true` + re-sign with the ER blockhash/fee payer; the npm
  `@coral-xyz/anchor` caps at **0.32.1** (1.0.x doesn't exist on npm).
- Crank signer = `crank_signer_pda(authority)` in `magic-program-api` ≥ 0.12 (per-authority).
- More: `../knowledge/07-flash-trade.md` and `../knowledge/03-dev-workflow.md`.

## Status

Fully working on devnet end-to-end, hardened after a full security/economics/judge review. The
settlement-timing exploit (resolver chose the settle print) is closed by the on-chain window +
the daemon sweeper; stale-strike sniping is closed by `max_feed_age_ms` (2.5s) < `min_duration`
(5s); dead-feed fund-stranding is closed by `void_bet`; faucet abuse is rate-limited; the
leaderboard merges ER (live) + L1 (settled). Then a **visibility pass** put the depth on the
always-on surface (real ER latency on every settlement + a latency tape, an ambient ER-vs-L1
duel strip that auto-runs, a live Flash hedge badge, House-book-vs-Hedge P&L chart, a live
backdrop behind onboarding) and added **one-touch barrier options** — the impossible-on-L1
mechanic (continuous in-window barrier monitoring via check_touch). Verified live on devnet:
crypto + exotic bets swept by the daemon with no browser, void refund on a frozen feed, one-touch
win via barrier crossing, full browser onboard→bet→settle for both binary and touch.
Remaining for submission: host publicly, demo video (lead with the latency duel + a one-touch win),
Luma submission.
Honest caveats to state in the pitch: exotic prices are keeper-signed (crypto uses MagicBlock's
neutral oracle); the demo house is play-money while the hedge is real (directional, not fully
risk-neutral); the autonomous crank is localnet-proven and best-effort on the public devnet ER
(the permissionless sweeper covers it).

🤖 Built with [Claude Code](https://claude.com/claude-code)
