use anchor_lang::prelude::*;
use crate::{
    constants::*,
    state::{Policy, PolicyParams, DistributionProgress},
    events::PolicySetup,
};

#[derive(Accounts)]
pub struct SetupPolicy<'info> {
    /// Authority to setup policy (could be vault owner or admin)
    pub authority: Signer<'info>,
    
    /// Payer for account creation
    #[account(mut)]
    pub payer: Signer<'info>,
    
    /// Vault this policy applies to
    /// CHECK: Used as PDA seed
    pub vault: UncheckedAccount<'info>,
    
    /// Policy account
    #[account(
        init,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + Policy::INIT_SPACE
    )]
    pub policy: Account<'info, Policy>,
    
    /// Progress tracking account
    #[account(
        init,
        seeds = [PROGRESS_SEED, vault.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + DistributionProgress::INIT_SPACE
    )]
    pub progress: Account<'info, DistributionProgress>,
    
    pub system_program: Program<'info, System>,
}

pub fn handle_setup_policy(
    ctx: Context<SetupPolicy>,
    params: PolicyParams,
) -> Result<()> {
    // Validate policy parameters
    require!(
        params.investor_fee_share_bps <= BASIS_POINTS_DIVISOR as u16,
        crate::error::HonouraryError::InvalidPoolConfiguration
    );
    
    require!(
        params.y0_total_allocation > 0,
        crate::error::HonouraryError::InvalidPoolConfiguration
    );
    
    require!(
        params.min_payout_lamports >= MIN_PAYOUT_THRESHOLD,
        crate::error::HonouraryError::InvalidPoolConfiguration
    );

    require!(
        params.total_investors > 0,
        crate::error::HonouraryError::InvalidPoolConfiguration
    );

    // Initialize policy
    let policy = &mut ctx.accounts.policy;
    policy.vault = ctx.accounts.vault.key();
    policy.creator_wallet = params.creator_wallet;
    policy.investor_fee_share_bps = params.investor_fee_share_bps;
    policy.daily_cap_lamports = params.daily_cap_lamports;
    policy.min_payout_lamports = params.min_payout_lamports;
    policy.y0_total_allocation = params.y0_total_allocation;
    policy.total_investors = params.total_investors;
    policy.bump = ctx.bumps.policy;
    policy.created_at = Clock::get()?.unix_timestamp;
    policy.updated_at = Clock::get()?.unix_timestamp;
    
    // Initialize progress tracking
    let progress = &mut ctx.accounts.progress;
    progress.vault = ctx.accounts.vault.key();
    progress.last_distribution_ts = 0;
    progress.current_day_distributed = 0;
    progress.current_day_carry_over = 0;
    progress.pagination_cursor = 0;
    progress.day_completed = true; // Start as completed so first crank works
    progress.current_day_total_claimed = 0;
    progress.bump = ctx.bumps.progress;
    progress.total_distributions = 0;
    progress.total_investor_distributed = 0;
    progress.total_creator_distributed = 0;
    progress.current_day_total_locked_all = 0;
    progress.persistent_carry_over = 0;
    progress.paid_investor_bitmap = [0u8; 256]; // Initialize bitmap as all zeros
    
    emit!(PolicySetup {
        vault: ctx.accounts.vault.key(),
        creator_wallet: params.creator_wallet,
        investor_fee_share_bps: params.investor_fee_share_bps,
        y0_total_allocation: params.y0_total_allocation,
        timestamp: Clock::get()?.unix_timestamp,
    });
    
    Ok(())
}