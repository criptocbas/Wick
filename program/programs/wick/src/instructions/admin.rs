use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::WickError;
use crate::events::PricePushed;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + House::INIT_SPACE, seeds = [HOUSE_SEED], bump)]
    pub house: Account<'info, House>,
    /// CHECK: PDA that owns the vault token account
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_TOKEN_SEED],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, price_authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.price_authority = price_authority;
    config.mint = ctx.accounts.mint.key();
    config.payout_bps = 19_000; // 1.9x total return on a win
    config.min_bet = 100_000; // 0.1 (6-decimal token)
    config.max_bet = 1_000_000_000; // 1,000
    config.min_duration_s = 5;
    config.max_duration_s = 300;
    config.max_feed_age_ms = 10_000;
    config.num_markets = 0;
    config.paused = false;
    config.bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault_authority;
    config.vault_token_bump = ctx.bumps.vault;

    let house = &mut ctx.accounts.house;
    house.balance = 0;
    house.locked = 0;
    house.lifetime_pnl = 0;
    house.bump = ctx.bumps.house;
    Ok(())
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 12])]
pub struct CreateFeed<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + WickFeed::INIT_SPACE, seeds = [FEED_SEED, &symbol], bump)]
    pub feed: Account<'info, WickFeed>,
    pub system_program: Program<'info, System>,
}

pub fn create_feed(ctx: Context<CreateFeed>, symbol: [u8; 12]) -> Result<()> {
    let feed = &mut ctx.accounts.feed;
    feed.symbol = symbol;
    feed.price = 0;
    feed.expo = 0;
    feed.ts_ms = 0;
    feed.bump = ctx.bumps.feed;
    Ok(())
}

#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct CreateMarket<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + MarketConfig::INIT_SPACE, seeds = [MARKET_SEED, &[idx]], bump)]
    pub market: Account<'info, MarketConfig>,
    #[account(init, payer = admin, space = 8 + MarketBook::INIT_SPACE, seeds = [BOOK_SEED, &[idx]], bump)]
    pub book: Account<'info, MarketBook>,
    pub system_program: Program<'info, System>,
}

pub fn create_market(
    ctx: Context<CreateMarket>,
    idx: u8,
    symbol: [u8; 12],
    feed_kind: u8,
    feed: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(idx == config.num_markets, WickError::BadMarketIndex);
    require!(feed_kind <= FEED_KIND_WICK, WickError::InvalidFeed);

    if feed_kind == FEED_KIND_WICK {
        let (expected, _) = Pubkey::find_program_address(&[FEED_SEED, &symbol], &crate::ID);
        require_keys_eq!(feed, expected, WickError::FeedMismatch);
    }

    let market = &mut ctx.accounts.market;
    market.idx = idx;
    market.feed_kind = feed_kind;
    market.enabled = true;
    market.symbol = symbol;
    market.feed = feed;
    market.bump = ctx.bumps.market;

    let book = &mut ctx.accounts.book;
    book.idx = idx;
    book.bump = ctx.bumps.book;

    config.num_markets += 1;
    Ok(())
}

/// Keeper-pushed price update for Wick feeds (Flash Trade exotics; localnet testing).
/// Runs on L1 before the feed is delegated, and on the ER (gasless) after.
#[derive(Accounts)]
pub struct PushPrice<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub feed: Account<'info, WickFeed>,
}

pub fn push_price(
    ctx: Context<PushPrice>,
    symbol: [u8; 12],
    price: i64,
    expo: i32,
    ts_ms: i64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.price_authority,
        WickError::Unauthorized
    );
    let feed = &mut ctx.accounts.feed;
    require!(feed.symbol == symbol, WickError::SymbolMismatch);
    require!(price > 0 && ts_ms >= feed.ts_ms, WickError::InvalidFeed);
    feed.price = price;
    feed.expo = expo;
    feed.ts_ms = ts_ms;
    emit!(PricePushed { symbol, price, expo, ts_ms });
    Ok(())
}

#[derive(Accounts)]
pub struct FundHouse<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(mut, token::mint = config.mint, token::authority = admin)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED], bump = config.vault_token_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn fund_house(ctx: Context<FundHouse>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount,
    )?;
    let house = &mut ctx.accounts.house;
    house.balance = house.balance.checked_add(amount).ok_or(WickError::MathOverflow)?;
    Ok(())
}
