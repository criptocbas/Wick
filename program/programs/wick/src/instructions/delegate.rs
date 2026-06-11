use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::errors::WickError;
use crate::state::*;

fn validator_from(remaining: &[AccountInfo]) -> Option<Pubkey> {
    remaining.first().map(|a| a.key())
}

/// A user delegates their own account into the ER to start a session.
#[delegate]
#[derive(Accounts)]
pub struct DelegateUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: UserAccount PDA, seeds checked by the delegation CPI
    #[account(mut, del)]
    pub user_account: UncheckedAccount<'info>,
}

pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
    let authority = ctx.accounts.payer.key();
    ctx.accounts.delegate_user_account(
        &ctx.accounts.payer,
        &[USER_SEED, authority.as_ref()],
        DelegateConfig {
            validator: validator_from(ctx.remaining_accounts),
            ..Default::default()
        },
    )?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateHouse<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: House PDA, seeds checked by the delegation CPI
    #[account(mut, del)]
    pub house: UncheckedAccount<'info>,
}

pub fn delegate_house(ctx: Context<DelegateHouse>) -> Result<()> {
    ctx.accounts.delegate_house(
        &ctx.accounts.payer,
        &[HOUSE_SEED],
        DelegateConfig {
            validator: validator_from(ctx.remaining_accounts),
            ..Default::default()
        },
    )?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBook<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: MarketBook PDA, seeds checked by the delegation CPI
    #[account(mut, del)]
    pub book: UncheckedAccount<'info>,
}

pub fn delegate_book(ctx: Context<DelegateBook>, idx: u8) -> Result<()> {
    ctx.accounts.delegate_book(
        &ctx.accounts.payer,
        &[BOOK_SEED, &[idx]],
        DelegateConfig {
            validator: validator_from(ctx.remaining_accounts),
            ..Default::default()
        },
    )?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateFeed<'info> {
    #[account(mut, address = config.admin @ WickError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: WickFeed PDA, seeds checked by the delegation CPI
    #[account(mut, del)]
    pub feed: UncheckedAccount<'info>,
}

pub fn delegate_feed(ctx: Context<DelegateFeed>, symbol: [u8; 12]) -> Result<()> {
    ctx.accounts.delegate_feed(
        &ctx.accounts.payer,
        &[FEED_SEED, &symbol],
        DelegateConfig {
            validator: validator_from(ctx.remaining_accounts),
            ..Default::default()
        },
    )?;
    Ok(())
}
