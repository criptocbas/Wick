use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::WickError;
use crate::events::{Deposited, Withdrawn};
use crate::state::*;

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, authority.key().as_ref()],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,
    pub system_program: Program<'info, System>,
}

pub fn init_user(ctx: Context<InitUser>, session_key: Pubkey) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    user.authority = ctx.accounts.authority.key();
    user.session_key = session_key;
    user.bump = ctx.bumps.user_account;
    Ok(())
}

/// L1 only — fails while the user account is delegated (owner check), by design.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [USER_SEED, authority.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut, token::mint = config.mint, token::authority = authority)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED], bump = config.vault_token_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, WickError::InsufficientBalance);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;
    let user = &mut ctx.accounts.user_account;
    user.balance = user.balance.checked_add(amount).ok_or(WickError::MathOverflow)?;
    emit!(Deposited {
        user: user.authority,
        amount,
        balance: user.balance,
    });
    Ok(())
}

/// L1 only — the user account must be undelegated (settled) to withdraw real tokens.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [USER_SEED, authority.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
    /// CHECK: PDA that owns the vault token account
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED], bump = config.vault_token_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, token::authority = authority)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    require!(amount > 0 && user.balance >= amount, WickError::InsufficientBalance);
    user.balance -= amount;

    let bump = ctx.accounts.config.vault_bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(Withdrawn {
        user: user.authority,
        amount,
        balance: user.balance,
    });
    Ok(())
}

/// Rotates the session key. Works on L1 when undelegated and on the ER when delegated;
/// always requires the wallet authority itself to sign.
#[derive(Accounts)]
pub struct SetSessionKey<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, authority.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn set_session_key(ctx: Context<SetSessionKey>, new_key: Pubkey) -> Result<()> {
    ctx.accounts.user_account.session_key = new_key;
    Ok(())
}
