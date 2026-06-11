use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::WickError;
use crate::events::{BetPlaced, BetResolved};
use crate::oracle::{self, cmp_prices};
use crate::state::*;

/// Open a position. Runs on the ER: every writable account here must be delegated.
#[derive(Accounts)]
pub struct PlaceBet<'info> {
    /// Wallet authority or the registered session key.
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [MARKET_SEED, &[market.idx]], bump = market.bump)]
    pub market: Account<'info, MarketConfig>,
    #[account(mut, seeds = [BOOK_SEED, &[market.idx]], bump = book.bump)]
    pub book: Account<'info, MarketBook>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
    /// CHECK: pinned to market.feed inside oracle::read_price
    pub feed: UncheckedAccount<'info>,
}

pub fn place_bet(ctx: Context<PlaceBet>, direction: u8, stake: u64, duration_s: u32) -> Result<()> {
    let config = &ctx.accounts.config;
    let market = &ctx.accounts.market;
    require!(!config.paused, WickError::Paused);
    require!(market.enabled, WickError::MarketDisabled);
    require!(direction <= DIRECTION_UP, WickError::InvalidFeed);
    require!(
        duration_s >= config.min_duration_s as u32 && duration_s <= config.max_duration_s as u32,
        WickError::InvalidDuration
    );
    require!(stake >= config.min_bet, WickError::BetTooSmall);
    require!(stake <= config.max_bet, WickError::BetTooLarge);

    let user = &mut ctx.accounts.user_account;
    require!(user.is_operator(&ctx.accounts.operator.key()), WickError::Unauthorized);
    require!(user.balance >= stake, WickError::InsufficientBalance);
    let slot = user.free_slot().ok_or(WickError::NoFreeBetSlot)?;

    let price = oracle::read_price(market, &ctx.accounts.feed)?;
    let now_ms = Clock::get()?
        .unix_timestamp
        .checked_mul(1000)
        .ok_or(WickError::MathOverflow)?;
    require!(
        now_ms.saturating_sub(price.ts_ms) <= config.max_feed_age_ms as i64,
        WickError::StaleFeed
    );

    // Solvency: reserve the potential profit against house liquidity before accepting.
    let profit = stake
        .checked_mul(config.payout_bps as u64 - BPS)
        .ok_or(WickError::MathOverflow)?
        / BPS;
    let house = &mut ctx.accounts.house;
    let locked = house.locked.checked_add(profit).ok_or(WickError::MathOverflow)?;
    require!(house.balance >= locked, WickError::InsufficientHouseLiquidity);
    house.locked = locked;

    user.balance -= stake;
    user.total_wagered = user.total_wagered.saturating_add(stake);
    user.open_bets += 1;
    let expiry_ms = price
        .ts_ms
        .checked_add(duration_s as i64 * 1000)
        .ok_or(WickError::MathOverflow)?;
    user.bets[slot] = Bet {
        status: BET_STATUS_OPEN,
        direction,
        market_idx: market.idx,
        _pad: 0,
        stake,
        potential_profit: profit,
        strike: price.price,
        expo: price.expo,
        placed_ms: price.ts_ms,
        expiry_ms,
    };

    let book = &mut ctx.accounts.book;
    if direction == DIRECTION_UP {
        book.long_open = book.long_open.saturating_add(stake);
    } else {
        book.short_open = book.short_open.saturating_add(stake);
    }
    book.volume = book.volume.saturating_add(stake);
    book.open_bets += 1;

    emit!(BetPlaced {
        user: user.authority,
        market_idx: market.idx,
        bet_idx: slot as u8,
        direction,
        stake,
        strike: price.price,
        expo: price.expo,
        placed_ms: price.ts_ms,
        expiry_ms,
    });
    Ok(())
}

/// Settle an expired bet against the first feed print at/after expiry.
/// Permissionless: the frontend auto-fires it, and anyone can sweep stragglers.
#[derive(Accounts)]
pub struct ResolveBet<'info> {
    pub resolver: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [MARKET_SEED, &[market.idx]], bump = market.bump)]
    pub market: Account<'info, MarketConfig>,
    #[account(mut, seeds = [BOOK_SEED, &[market.idx]], bump = book.bump)]
    pub book: Account<'info, MarketBook>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
    /// CHECK: pinned to market.feed inside oracle::read_price
    pub feed: UncheckedAccount<'info>,
}

pub fn resolve_bet(ctx: Context<ResolveBet>, bet_idx: u8) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    let market = &ctx.accounts.market;
    let bet = *user
        .bets
        .get(bet_idx as usize)
        .ok_or(WickError::BetNotOpen)?;
    require!(bet.status == BET_STATUS_OPEN, WickError::BetNotOpen);
    require!(bet.market_idx == market.idx, WickError::MarketMismatch);

    let price = oracle::read_price(market, &ctx.accounts.feed)?;
    require!(price.ts_ms >= bet.expiry_ms, WickError::NotExpired);

    let ord = cmp_prices(price.price, price.expo, bet.strike, bet.expo)?;
    let won = match ord {
        std::cmp::Ordering::Equal => None, // push
        std::cmp::Ordering::Greater => Some(bet.direction == DIRECTION_UP),
        std::cmp::Ordering::Less => Some(bet.direction == DIRECTION_DOWN),
    };

    let house = &mut ctx.accounts.house;
    house.locked = house.locked.saturating_sub(bet.potential_profit);

    let (outcome, payout) = match won {
        Some(true) => {
            let payout = bet.stake + bet.potential_profit;
            user.balance = user.balance.checked_add(payout).ok_or(WickError::MathOverflow)?;
            user.wins += 1;
            user.streak += 1;
            user.best_streak = user.best_streak.max(user.streak);
            user.pnl += bet.potential_profit as i64;
            house.balance = house
                .balance
                .checked_sub(bet.potential_profit)
                .ok_or(WickError::MathOverflow)?;
            house.lifetime_pnl -= bet.potential_profit as i64;
            (OUTCOME_WIN, payout)
        }
        Some(false) => {
            user.losses += 1;
            user.streak = 0;
            user.pnl -= bet.stake as i64;
            house.balance = house.balance.checked_add(bet.stake).ok_or(WickError::MathOverflow)?;
            house.lifetime_pnl += bet.stake as i64;
            (OUTCOME_LOSS, 0)
        }
        None => {
            user.balance = user.balance.checked_add(bet.stake).ok_or(WickError::MathOverflow)?;
            user.pushes += 1;
            (OUTCOME_PUSH, bet.stake)
        }
    };

    user.bets[bet_idx as usize] = Bet::default();
    user.open_bets = user.open_bets.saturating_sub(1);

    let book = &mut ctx.accounts.book;
    if bet.direction == DIRECTION_UP {
        book.long_open = book.long_open.saturating_sub(bet.stake);
    } else {
        book.short_open = book.short_open.saturating_sub(bet.stake);
    }
    book.open_bets = book.open_bets.saturating_sub(1);

    emit!(BetResolved {
        user: user.authority,
        market_idx: market.idx,
        bet_idx,
        outcome,
        stake: bet.stake,
        payout,
        strike: bet.strike,
        settle_price: price.price,
        expo: price.expo,
    });
    Ok(())
}

/// Checkpoint a user account's ER state to L1 without ending the session.
#[commit]
#[derive(Accounts)]
pub struct CommitUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn commit_user(ctx: Context<CommitUser>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.user_account.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

/// End a session: commit and return the user account to L1 so tokens can be withdrawn.
#[commit]
#[derive(Accounts)]
pub struct UndelegateUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn undelegate_user(ctx: Context<UndelegateUser>) -> Result<()> {
    let user = &ctx.accounts.user_account;
    require!(user.is_operator(&ctx.accounts.payer.key()), WickError::Unauthorized);
    require!(user.open_bets == 0, WickError::OpenBetsRemain);
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.user_account.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

/// Admin maintenance: commit + undelegate any set of protocol accounts
/// (house / books / feeds) passed as remaining accounts.
#[commit]
#[derive(Accounts)]
pub struct UndelegateOps<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn undelegate_ops<'info>(ctx: Context<'info, UndelegateOps<'info>>) -> Result<()> {
    require!(!ctx.remaining_accounts.is_empty(), WickError::InvalidFeed);
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(ctx.remaining_accounts)
    .build_and_invoke()?;
    Ok(())
}
