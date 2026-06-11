# 🕯️ Wick

**Ten seconds. One direction. No liquidations.**

Wick is an ultra-short-dated options venue running inside a [MagicBlock Ephemeral Rollup](https://docs.magicblock.gg):
pick a market, pick a direction, pick an expiry (5–60 seconds), stake USDC. Your position
confirms in under 50 ms, gaslessly, and settles against a live oracle print the moment the
clock hits zero — payouts land before your next blink.

The house doesn't bet against you and pray: a keeper continuously reads the vault's net
directional exposure from the rollup and hedges it with **real perpetual positions on
[Flash Trade](https://flash.trade)** — and Flash's 90-market synthetic universe (Nvidia, gold,
EUR/USD, …) feeds Wick's exotic markets. A real derivatives desk, fully on-chain.

> Built for **Solana Blitz v5 — "Trading"** (June 12–14, 2026).

## Why this can't exist anywhere else

A 5-second option is *physically impossible* on the base layer: ~400 ms slots, fees per tap,
confirmation variance bigger than the bet itself. On an Ephemeral Rollup the whole loop —
open → tick → expire → settle → restake — runs at 10–50 ms for zero fees, while **custody
never leaves Solana L1**: deposits sit in an escrow vault, the rollup only executes, and any
user can permissionlessly undelegate and withdraw even if every Wick server disappears.

Unlike every offshore binary-options site: the price is Pyth Lazer, the settlement logic is
this open-source program, the house edge is one published number, and the hedge book is a
wallet you can watch on flash.trade.

## Architecture

```
        Solana L1 (custody)                    Ephemeral Rollup (~50ms, gasless)
┌──────────────────────────────┐  delegate   ┌──────────────────────────────────────┐
│ USDC vault (users + house)   │ ──────────► │ balances · open bets · house book    │
│ market configs               │             │ MagicBlock oracle: SOL/BTC/ETH       │
└──────────────────────────────┘ ◄─commit─── │ WickFeeds: NVDA/XAU/EUR (Flash px)   │
        ▲ withdraw                           │ place_bet / resolve_bet (sub-50ms)   │
        │                                    └──────────────┬───────────────────────┘
┌───────┴────────┐                                          │ net delta per market
│  user wallet   │            hedger keeper                 ▼
└────────────────┘   POST flashapi.trade /v2/open-position  ┌─────────────────────┐
                     (offsetting perps, owner WS monitored) │ Flash Trade mainnet │
                                                            └─────────────────────┘
```

- **`program/`** — the Anchor program (Anchor 1.0.2, `ephemeral-rollups-sdk` 0.14.x).
  Escrowed balances, per-market books, house solvency reserve, oracle-settled bets,
  full delegate → trade → commit → undelegate lifecycle.
- **`app/`** — the trading interface. One-tap gasless trading via session keys,
  optimistic UI, live ER WebSocket state.
- **`keepers/`** — the FlashFeed pusher (Flash Trade `/v2/prices` → delegated feed PDAs,
  ~200 ms, free because ER) and the Flash Trade hedger (net exposure → real mainnet perps).

## Settlement rules

- Strike = the oracle print your bet was opened against (price + timestamp from the feed
  account itself, not wall clocks).
- Expiry = strike timestamp + duration. Settlement uses the **first print at or after expiry**.
- Up wins if settle > strike, down wins if settle < strike, exact tie = push (full refund).
- Win pays 1.9× the stake (published edge, configurable). House liquidity is reserved at
  placement (`locked`), so every open bet is always fully covered — solvency by construction.

## Running locally

```bash
# toolchain: Solana 3.1.9 · Rust 1.89+ · Anchor 1.0.2 · Node 24+
npm install -g @magicblock-labs/ephemeral-validator@latest

# 1) base layer (:8899/:8900)
mb-test-validator --reset

# 2) build + deploy
cd program && anchor build && anchor deploy --provider.cluster localnet

# 3) the rollup (:7799/:7800)
ephemeral-validator --remotes "http://localhost:8899" --remotes "ws://localhost:8900" \
  -l "7799" --lifecycle ephemeral

# 4) full lifecycle test (deposit → delegate → bet → resolve → undelegate → withdraw)
npm install && anchor test --provider.cluster localnet --skip-local-validator --skip-build --skip-deploy
```

## Program

Devnet program ID: `9Ab2YXtmKwFgEsGGQFkL53E2rSwtnqFptKxRXfV8uaAX`

---

🤖 Built with [Claude Code](https://claude.com/claude-code)
