use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const HOUSE_SEED: &[u8] = b"house";
pub const MARKET_SEED: &[u8] = b"market";
pub const BOOK_SEED: &[u8] = b"book";
pub const USER_SEED: &[u8] = b"user";
pub const FEED_SEED: &[u8] = b"feed";

pub const MAX_OPEN_BETS: usize = 8;
pub const BPS: u64 = 10_000;

/// Price feed flavors a market can settle against.
pub const FEED_KIND_PYTH_LAZER: u8 = 0; // MagicBlock real-time pricing oracle (PriceUpdateV2 layout)
pub const FEED_KIND_WICK: u8 = 1; // Wick-pushed feed (Flash Trade /v2/prices, ms precision)

pub const BET_STATUS_EMPTY: u8 = 0;
pub const BET_STATUS_OPEN: u8 = 1;

pub const DIRECTION_DOWN: u8 = 0;
pub const DIRECTION_UP: u8 = 1;

/// Bet flavors. A BINARY bet compares strike vs the settle print at expiry; a
/// TOUCH bet (one-touch barrier option) wins the instant the price reaches the
/// barrier at any in-window print, and loses if it never does. TOUCH needs
/// continuous in-window monitoring — uneconomical on L1, ~free on the ER.
pub const BET_KIND_BINARY: u8 = 0;
pub const BET_KIND_TOUCH: u8 = 1;

/// Allowed barrier distances (bps from the strike-time price) and their flat
/// demo payouts — farther barrier is harder to touch, so it pays more. These
/// are intuitive demo odds, not a vol-calibrated touch-probability model.
pub fn touch_payout_bps(barrier_bps: u32) -> Option<u16> {
    match barrier_bps {
        10 => Some(14_000),  // 0.10% away → 1.4x
        25 => Some(19_000),  // 0.25% away → 1.9x
        50 => Some(30_000),  // 0.50% away → 3.0x
        100 => Some(60_000), // 1.00% away → 6.0x
        _ => None,
    }
}

pub const OUTCOME_LOSS: u8 = 0;
pub const OUTCOME_WIN: u8 = 1;
pub const OUTCOME_PUSH: u8 = 2;
/// No qualifying settlement print existed inside the grace window (dead feed /
/// missed window) — the stake is refunded. Counted as a push on the record.
pub const OUTCOME_VOID: u8 = 3;

/// Extra wall-clock slack past the settlement window before a bet may be
/// voided, so live resolvers always get the full window first.
pub const VOID_DELAY_MS: i64 = 2_000;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Keeper key allowed to push WickFeed prices (Flash Trade exotics).
    pub price_authority: Pubkey,
    pub mint: Pubkey,
    /// Total return on a win in bps of stake (19_000 = 1.9x back, 0.9x profit).
    pub payout_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub min_duration_s: u16,
    pub max_duration_s: u16,
    /// Max age of a feed print at placement time, in ms. Must stay well below
    /// min_duration_s*1000 so a bet can never be born at (or past) expiry.
    pub max_feed_age_ms: u32,
    /// Settlement must use a print in [expiry, expiry + resolve_grace_ms];
    /// past that the bet is voidable (stake refunded) instead of resolvable.
    pub resolve_grace_ms: u32,
    /// Expected owner of kind-0 (Pyth Lazer) feed accounts on the ER.
    /// Pubkey::default() disables the check (localnet has no kind-0 markets).
    pub oracle_program: Pubkey,
    pub num_markets: u8,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub vault_token_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    pub idx: u8,
    pub feed_kind: u8,
    pub enabled: bool,
    pub symbol: [u8; 12],
    /// Pinned feed account this market settles against.
    pub feed: Pubkey,
    pub bump: u8,
}

/// Per-market open-interest book. Delegated to the ER; read by the hedger keeper.
#[account]
#[derive(InitSpace)]
pub struct MarketBook {
    pub idx: u8,
    pub long_open: u64,
    pub short_open: u64,
    pub volume: u64,
    pub open_bets: u32,
    pub bump: u8,
}

/// House liquidity ledger. Tokens live in the L1 vault; this tracks the house share.
#[account]
#[derive(InitSpace)]
pub struct House {
    pub balance: u64,
    /// Sum of potential profit payouts across all open bets (solvency reserve).
    pub locked: u64,
    pub lifetime_pnl: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Bet {
    pub status: u8,
    pub direction: u8,
    pub market_idx: u8,
    /// BET_KIND_BINARY or BET_KIND_TOUCH.
    pub kind: u8,
    pub stake: u64,
    pub potential_profit: u64,
    /// BINARY: the strike price. TOUCH: the barrier price (direction = which
    /// side: UP = barrier above the entry, DOWN = barrier below).
    pub strike: i64,
    pub expo: i32,
    pub placed_ms: i64,
    pub expiry_ms: i64,
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub authority: Pubkey,
    /// Ephemeral browser key allowed to trade for this account (gasless one-tap UX).
    pub session_key: Pubkey,
    pub balance: u64,
    pub open_bets: u8,
    pub wins: u32,
    pub losses: u32,
    pub pushes: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub total_wagered: u64,
    pub pnl: i64,
    pub bets: [Bet; MAX_OPEN_BETS],
    pub bump: u8,
}

impl UserAccount {
    pub fn free_slot(&self) -> Option<usize> {
        self.bets.iter().position(|b| b.status == BET_STATUS_EMPTY)
    }

    pub fn is_operator(&self, key: &Pubkey) -> bool {
        *key == self.authority || (*key == self.session_key && self.session_key != Pubkey::default())
    }
}

/// Wick's own pushed feed (Flash Trade exotic markets; also used on localnet).
/// ts_ms is millisecond-precision, unlike Pyth receiver's seconds.
#[account]
#[derive(InitSpace)]
pub struct WickFeed {
    pub symbol: [u8; 12],
    pub price: i64,
    pub expo: i32,
    pub ts_ms: i64,
    pub bump: u8,
}

pub fn symbol_to_bytes(symbol: &str) -> [u8; 12] {
    let mut out = [0u8; 12];
    let bytes = symbol.as_bytes();
    let n = bytes.len().min(12);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}
