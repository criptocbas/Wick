use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("G6Biewd4imM1depq2WpJNomAhM63Y6DVjNYsZWHnAWdi");

#[ephemeral]
#[program]
pub mod wick {
    use super::*;

    // ── Admin (L1) ────────────────────────────────────────────────
    pub fn initialize(
        ctx: Context<Initialize>,
        price_authority: Pubkey,
        oracle_program: Pubkey,
    ) -> Result<()> {
        instructions::admin::initialize(ctx, price_authority, oracle_program)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_params(
        ctx: Context<SetParams>,
        payout_bps: u16,
        min_bet: u64,
        max_bet: u64,
        min_duration_s: u16,
        max_duration_s: u16,
        max_feed_age_ms: u32,
        resolve_grace_ms: u32,
        paused: bool,
    ) -> Result<()> {
        instructions::admin::set_params(
            ctx,
            payout_bps,
            min_bet,
            max_bet,
            min_duration_s,
            max_duration_s,
            max_feed_age_ms,
            resolve_grace_ms,
            paused,
        )
    }

    pub fn set_market_enabled(
        ctx: Context<SetMarketEnabled>,
        idx: u8,
        enabled: bool,
    ) -> Result<()> {
        instructions::admin::set_market_enabled(ctx, idx, enabled)
    }

    pub fn create_feed(ctx: Context<CreateFeed>, symbol: [u8; 12]) -> Result<()> {
        instructions::admin::create_feed(ctx, symbol)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        idx: u8,
        symbol: [u8; 12],
        feed_kind: u8,
        feed: Pubkey,
    ) -> Result<()> {
        instructions::admin::create_market(ctx, idx, symbol, feed_kind, feed)
    }

    pub fn fund_house(ctx: Context<FundHouse>, amount: u64) -> Result<()> {
        instructions::admin::fund_house(ctx, amount)
    }

    // ── Price pushing (L1 pre-delegation, then ER) ────────────────
    pub fn push_price(
        ctx: Context<PushPrice>,
        symbol: [u8; 12],
        price: i64,
        expo: i32,
        ts_ms: i64,
    ) -> Result<()> {
        instructions::admin::push_price(ctx, symbol, price, expo, ts_ms)
    }

    // ── User custody (L1) ─────────────────────────────────────────
    pub fn init_user(ctx: Context<InitUser>, session_key: Pubkey) -> Result<()> {
        instructions::user::init_user(ctx, session_key)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::user::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::user::withdraw(ctx, amount)
    }

    pub fn set_session_key(ctx: Context<SetSessionKey>, new_key: Pubkey) -> Result<()> {
        instructions::user::set_session_key(ctx, new_key)
    }

    // ── Delegation (L1 → ER) ──────────────────────────────────────
    pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
        instructions::delegate::delegate_user(ctx)
    }

    pub fn delegate_house(ctx: Context<DelegateHouse>) -> Result<()> {
        instructions::delegate::delegate_house(ctx)
    }

    pub fn delegate_book(ctx: Context<DelegateBook>, idx: u8) -> Result<()> {
        instructions::delegate::delegate_book(ctx, idx)
    }

    pub fn delegate_feed(ctx: Context<DelegateFeed>, symbol: [u8; 12]) -> Result<()> {
        instructions::delegate::delegate_feed(ctx, symbol)
    }

    // ── Hot path (ER) ─────────────────────────────────────────────
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        direction: u8,
        stake: u64,
        duration_s: u32,
    ) -> Result<()> {
        instructions::er::place_bet(ctx, direction, stake, duration_s)
    }

    pub fn place_touch_bet(
        ctx: Context<PlaceBet>,
        direction: u8,
        stake: u64,
        duration_s: u32,
        barrier_bps: u32,
    ) -> Result<()> {
        instructions::er::place_touch_bet(ctx, direction, stake, duration_s, barrier_bps)
    }

    pub fn check_touch(ctx: Context<ResolveBet>, bet_idx: u8) -> Result<()> {
        instructions::er::check_touch(ctx, bet_idx)
    }

    pub fn resolve_bet(ctx: Context<ResolveBet>, bet_idx: u8) -> Result<()> {
        instructions::er::resolve_bet(ctx, bet_idx)
    }

    pub fn void_bet(ctx: Context<VoidBet>, bet_idx: u8) -> Result<()> {
        instructions::er::void_bet(ctx, bet_idx)
    }

    pub fn arm_resolution(ctx: Context<ArmResolution>, bet_idx: u8) -> Result<()> {
        instructions::er::arm_resolution(ctx, bet_idx)
    }

    // ── Settlement (ER → L1) ──────────────────────────────────────
    pub fn commit_user(ctx: Context<CommitUser>) -> Result<()> {
        instructions::er::commit_user(ctx)
    }

    pub fn undelegate_user(ctx: Context<UndelegateUser>) -> Result<()> {
        instructions::er::undelegate_user(ctx)
    }

    pub fn undelegate_ops<'info>(ctx: Context<'info, UndelegateOps<'info>>) -> Result<()> {
        instructions::er::undelegate_ops(ctx)
    }
}
