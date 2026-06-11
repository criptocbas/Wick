use anchor_lang::prelude::*;

#[event]
pub struct BetPlaced {
    pub user: Pubkey,
    pub market_idx: u8,
    pub bet_idx: u8,
    pub direction: u8,
    pub stake: u64,
    pub strike: i64,
    pub expo: i32,
    pub placed_ms: i64,
    pub expiry_ms: i64,
}

#[event]
pub struct BetResolved {
    pub user: Pubkey,
    pub market_idx: u8,
    pub bet_idx: u8,
    pub outcome: u8,
    pub stake: u64,
    pub payout: u64,
    pub strike: i64,
    pub settle_price: i64,
    pub expo: i32,
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[event]
pub struct Withdrawn {
    pub user: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[event]
pub struct PricePushed {
    pub symbol: [u8; 12],
    pub price: i64,
    pub expo: i32,
    pub ts_ms: i64,
}
