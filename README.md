# 🕯️ Wick

**Ten seconds. One direction. No liquidations.**

Wick is an ultra-short-dated options venue running inside a [MagicBlock Ephemeral Rollup](https://docs.magicblock.gg):
pick a market, pick a direction, pick an expiry (5–60 seconds), stake USDC. Your position
confirms in under 50 ms, gaslessly, and settles against a live oracle print the moment the
clock hits zero — payouts land before your next blink.

The house doesn't bet against you and pray: a keeper continuously reads the vault's net
directional exposure from the rollup and offsets it with **real perpetual positions on
[Flash Trade](https://flash.trade) mainnet** — and Flash's synthetic universe (Nvidia, gold,
EUR/USD, …) feeds Wick's exotic markets. A real derivatives desk you can watch on-chain.

> Built for **Solana Blitz v5 — "Trading"** (June 12–14, 2026).
> **Live on devnet** end-to-end: onboard → bet → settle → withdraw.

## Why an Ephemeral Rollup is load-bearing here

A 5-second option is *physically impossible* on the base layer: ~400 ms slots, a fee per tap,
and confirmation variance bigger than the bet itself. On an Ephemeral Rollup the whole loop —
open → tick → expire → settle → restake — runs at 10–50 ms for zero fees, while **custody
never leaves Solana L1**: deposits sit in an escrow vault, the rollup only executes, and any
user can permissionlessly undelegate and withdraw even if every Wick server disappears.

What makes Wick more than a tap-to-trade toy:

- **Provable custody** — real USDC stays in an L1 vault PDA; only accounting integers are
  delegated. You can never lose more than your stake, and you can always withdraw.
- **Tamper-evident settlement** — a bet settles only against an oracle print inside its
  settlement window, so nobody (not even the bettor) can wait for a luckier later price.
- **A real hedge desk** — net exposure is offset with live Flash Trade mainnet perps, not a
  paper hedge. The hedge wallet is a public address in the app's trust panel.
- **One published edge** — a win pays 1.9× the stake. No hidden spread, no feed shading.

## Architecture

```
        Solana L1 (custody)                    Ephemeral Rollup (~50ms, gasless)
┌──────────────────────────────┐  delegate   ┌──────────────────────────────────────┐
│ USDC vault (users + house)   │ ──────────► │ balances · open bets · house book    │
│ config · market configs      │             │ Pyth Lazer oracle: SOL/BTC/ETH       │
└──────────────────────────────┘ ◄─commit─── │ WickFeeds: NVDA/XAU/EUR (Flash px)   │
        ▲ withdraw                            │ place_bet / resolve_bet (sub-50ms)   │
        │                                     └──────────────┬───────────────────────┘
┌───────┴────────┐                                           │ net delta per market
│  user wallet   │            hedger keeper                  ▼
└────────────────┘   POST flashapi.trade /transaction-builder ┌─────────────────────┐
                     (offsetting V1 perps, owner monitored)   │ Flash Trade mainnet │
                                                              └─────────────────────┘
```

- **`program/`** — the Anchor program (Anchor 1.0.2, `ephemeral-rollups-sdk` 0.14.x).
  Escrowed balances, per-market books, house solvency reserve, windowed oracle settlement,
  void-on-dead-feed refunds, admin params/pause, full delegate → trade → commit → undelegate
  lifecycle. Devnet program ID **`HXuqCfyT96dnA1W9R1xHoEh75h8favw3p1v5jB1Zzgrj`**.
- **`app/`** — the trading interface. One-tap gasless trading via session keys, optimistic UI,
  live ER WebSocket state, a latency duel (ER vs L1), a "Provably fair" trust panel, and a
  streak leaderboard.
- **`keepers/`** — `setup.ts` (one-shot protocol bootstrap → `app/public/chain-config.json`),
  `daemon.ts` (gasless price pusher + **settlement sweeper** + faucet + read APIs), and
  `hedger.ts` (net ER exposure → real Flash Trade mainnet perps; `DRY_RUN` by default).

## Settlement rules

- **Strike** = the oracle print your bet was opened against (price + timestamp read from the
  feed account itself, not a wall clock). Placement rejects any print older than
  `max_feed_age_ms` (2.5 s), which is strictly below the shortest bet — so a bet can never be
  born stale or pre-expired.
- **Expiry** = strike timestamp + duration. A bet settles only against a print in the window
  **`[expiry, expiry + resolve_grace_ms]`** (3 s). Both bounds are enforced on-chain: too
  early reverts `NotExpired`, too late reverts `SettlementWindowMissed`. Nobody can cherry-pick
  a favorable late price.
- **Outcome** — up wins if settle > strike, down wins if settle < strike, exact tie = push
  (full refund). A win pays 1.9× the stake; house liquidity is reserved at placement
  (`locked`), so every open bet is always fully covered — **solvency by construction**.
- **Void** — if the feed goes dark and no qualifying print lands in the window, anyone can
  `void_bet` after a short delay to refund the stake. A dead feed can never strand funds.
- **Settlement is permissionless and runs three ways:** the bettor's own browser, the
  house-run daemon sweeper (a liveness backstop, not a privilege — anyone can run the same
  scan), and an on-chain MagicBlock crank where the rollup supports user-scheduled tasks.

## Run it

Toolchain: **Solana 3.1.9 · Rust 1.89+ · Anchor 1.0.2 · Node 24+** (`anchor` must resolve to 1.0.2).

### Devnet (the demo target)

```bash
# 1) build + deploy (use a fresh program id if a prior deploy "didn't take" — the
#    devnet ER caches cloned bytecode and may not re-clone an in-place upgrade)
cd program && anchor build && solana program deploy target/deploy/wick.so \
  --program-id target/deploy/wick-keypair.json --url devnet --with-compute-unit-price 120000
cp target/idl/wick.json ../app/src/chain/idl/wick.json   # keep every IDL consumer in sync

# 2) bootstrap the protocol (mint, markets, house liquidity, ER delegation) +
#    write app/public/chain-config.json
cd ../keepers && npm install && CLUSTER=devnet npm run setup

# 3) price pusher + settlement sweeper + faucet + read APIs
CLUSTER=devnet PRICE_SOURCE=flash npm run daemon

# 4) the app
cd ../app && npm install && npm run dev          # http://localhost:5173
```

### Hosting a public link

The app reads its daemon URL from `chain-config.json`. Point it at a publicly reachable daemon
and rebuild:

```bash
cd keepers && CLUSTER=devnet DAEMON_URL=https://your-daemon.example npm run setup
cd ../app && npm run build        # deploy app/dist/ to any static host
```

### Localnet (everything works incl. the crank)

```bash
mb-test-validator --reset                          # base layer :8899/:8900
# fd-limit shim — the rollup wants 1M fds
printf 'int setrlimit(int r,const void*l){return 0;}' >/tmp/norlimit.c && gcc -shared -fPIC -o /tmp/norlimit.so /tmp/norlimit.c
LD_PRELOAD=/tmp/norlimit.so ephemeral-validator --no-tui --lifecycle ephemeral \
  --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 --listen 127.0.0.1:7799 --reset
cd program && anchor build && solana program deploy target/deploy/wick.so \
  --program-id target/deploy/wick-keypair.json --url localhost
cd ../keepers && CLUSTER=localnet npm run setup && CLUSTER=localnet PRICE_SOURCE=synthetic npm run daemon
```

### Tests

```bash
cd program && anchor test --skip-local-validator --skip-build --skip-deploy   # full 2-layer lifecycle
cd keepers && CLUSTER=devnet npx tsx test-sweep.ts                            # daemon settles a bet, no browser
cd keepers && CLUSTER=devnet npx tsx test-void.ts                            # frozen feed → stake refunded
```

### Arm the live hedger (real Flash mainnet positions)

Fund a keypair with ~$40 USDC + 0.01 SOL, then:

```bash
cd keepers && HEDGER_KEYPAIR=… CLUSTER=devnet DRY_RUN=0 npm run hedger
# caps total notional, auto-flattens on Ctrl-C, reclaims empty-ATA rent.
# npm run hedger -- flatten   /   npm run hedger -- recover
```

## Verify it on-chain

Everything is auditable from a block explorer (append `?cluster=devnet` on Solscan):

- **Program** `HXuqCfyT96dnA1W9R1xHoEh75h8favw3p1v5jB1Zzgrj`
- **Escrow vault** — the `vault_token` PDA holds every user's and the house's USDC on L1.
- **Hedge wallet** — the public hedger address shown in the app's "Provably fair" panel; its
  Flash Trade positions are live mainnet perps.

## Honest caveats (stated up front)

- **Exotic prices are keeper-signed.** SOL/BTC/ETH settle against MagicBlock's neutral Pyth
  Lazer oracle; NVDA/gold/EUR are pushed by the daemon from Flash Trade's feed. The crypto
  markets are fully trust-minimized; the exotics trust the keeper not to shade a print.
- **The demo house is play-money; the hedge is real.** Users trade faucet wUSDC, but the
  hedger opens genuine Flash Trade mainnet perps. The hedge is a real cross-protocol
  round-trip, sized for a demo — it offsets directional exposure, not a fully delta/gamma
  risk-neutralized book.
- **The autonomous crank is best-effort on public devnet.** It's localnet-proven; where the
  public devnet ER doesn't run user-scheduled tasks, the permissionless daemon sweeper and the
  bettor's browser are the settlement path (and the on-chain window rules make timing safe
  regardless of who settles).

---

🤖 Built with [Claude Code](https://claude.com/claude-code)
