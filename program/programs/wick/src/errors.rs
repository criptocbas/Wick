use anchor_lang::prelude::*;

#[error_code]
pub enum WickError {
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Market is disabled")]
    MarketDisabled,
    #[msg("Signer is not authorized for this user account")]
    Unauthorized,
    #[msg("Stake is below the minimum bet")]
    BetTooSmall,
    #[msg("Stake is above the maximum bet")]
    BetTooLarge,
    #[msg("Duration outside the allowed range")]
    InvalidDuration,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("House liquidity cannot cover this bet")]
    InsufficientHouseLiquidity,
    #[msg("No free bet slot — resolve an open bet first")]
    NoFreeBetSlot,
    #[msg("Bet slot is not an open bet")]
    BetNotOpen,
    #[msg("Bet belongs to a different market")]
    MarketMismatch,
    #[msg("Bet has not expired yet — no settlement print available")]
    NotExpired,
    #[msg("Feed account does not match the market's pinned feed")]
    FeedMismatch,
    #[msg("Feed data is invalid or unsupported")]
    InvalidFeed,
    #[msg("Feed print is too old to open a position against")]
    StaleFeed,
    #[msg("Account still has open bets")]
    OpenBetsRemain,
    #[msg("Market index out of range")]
    BadMarketIndex,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Symbol mismatch")]
    SymbolMismatch,
    #[msg("Settlement print is past the grace window — this bet must be voided")]
    SettlementWindowMissed,
    #[msg("Bet is still resolvable — the settlement window has not closed")]
    BetNotVoidable,
    #[msg("Bet would already be expired at placement — feed print too old")]
    ExpiryInPast,
    #[msg("Invalid protocol parameters")]
    InvalidParams,
}
