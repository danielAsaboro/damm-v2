use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    TokenAccount,
    TokenInterface,
    transfer_checked,
    TransferChecked,
};
use crate::cp_amm_types::{ Pool, Position };
use crate::{
    constants::*,
    error::HonouraryError,
    state::{ InvestorFeePositionOwner, Policy, DistributionProgress },
    utils::math::*,
    integrations::{ cp_amm::claim_position_fees_quote_only },
    events::*,
};

#[derive(Accounts)]
#[instruction(page_start: u32, page_size: u32)]
pub struct CrankDistribution<'info> {
    /// Anyone can call the crank (permissionless)
    pub cranker: Signer<'info>,

    /// Vault identifier
    /// CHECK: Used as PDA seed
    pub vault: UncheckedAccount<'info>,

    /// Position owner PDA
    #[account(
        mut,
        seeds = [
            VAULT_SEED,
            vault.key().as_ref(),
            INVESTOR_FEE_POS_OWNER_SEED
        ],
        bump = position_owner.bump
    )]
    pub position_owner: Box<Account<'info, InvestorFeePositionOwner>>,

    /// Honorary position
    #[account(
        mut,
        constraint = position.nft_mint == position_owner.position_mint
    )]
    pub position: Box<Account<'info, Position>>,

    /// DAMM v2 pool
    #[account(constraint = pool.key() == position_owner.pool)]
    pub pool: Box<Account<'info, Pool>>,

    /// Pool authority
    /// CHECK: CP-AMM pool authority
    pub pool_authority: UncheckedAccount<'info>,

    /// Quote mint
    #[account(constraint = quote_mint.key() == position_owner.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,

    /// Base mint
    pub base_mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,

    /// Quote vault from pool
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Base vault from pool
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Program-owned treasury for quote tokens
    #[account(
        mut,
        seeds = [TREASURY_SEED, vault.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = position_owner
    )]
    pub treasury_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Program-owned treasury for base tokens (should remain zero)
    #[account(
        mut,
        seeds = [TREASURY_SEED, vault.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = position_owner
    )]
    pub base_treasury_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Creator's quote token ATA
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = policy.creator_wallet
    )]
    pub creator_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Position NFT account
    #[account(token::mint = position_owner.position_mint, token::authority = position_owner)]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Event authority for CP-AMM events
    /// CHECK: PDA derived by CP-AMM
    pub event_authority: UncheckedAccount<'info>,

    /// Program account for CP-AMM (for event CPI)
    /// CHECK: CP-AMM program account
    pub cp_amm_program_account: UncheckedAccount<'info>,

    /// Distribution policy
    #[account(seeds = [POLICY_SEED, vault.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,

    /// Distribution progress tracking
    #[account(
        mut,
        seeds = [PROGRESS_SEED, vault.key().as_ref()],
        bump = progress.bump
    )]
    pub progress: Box<Account<'info, DistributionProgress>>,

    /// Streamflow program
    /// CHECK: Streamflow program ID
    pub streamflow_program: UncheckedAccount<'info>,

    // Program accounts
    pub cp_amm_program: Program<'info, crate::cp_amm_types::CpAmm>,
    pub token_program: Interface<'info, TokenInterface>,

    // Remaining accounts: [stream_account, investor_ata] pairs for this page
    // The number of remaining accounts should be page_size * 2
}

pub fn handle_crank_distribution<'info>(
    ctx: Context<'_, '_, '_, 'info, CrankDistribution<'info>>,
    page_start: u32,
    page_size: u32,
    total_locked_all_investors: u64
) -> Result<()> {
    let progress = &mut ctx.accounts.progress;
    let policy = &ctx.accounts.policy;
    let current_time = Clock::get()?.unix_timestamp;

    // Validate pagination parameters
    require!(page_size > 0 && page_size <= MAX_PAGE_SIZE, HonouraryError::InvalidPagination);

    // Check if we can distribute (24-hour window or continuing same day)
    require!(progress.can_distribute(current_time), HonouraryError::CrankWindowNotReached);

    let is_first_page = page_start == 0 || progress.day_completed;

    // If first page of new day, claim fees and store TOTAL locked across ALL investors
    // NOTE: total_locked_all_investors must be calculated off-chain by the caller
    // by summing locked amounts from ALL investor Streamflow accounts, not just the current page.
    // This is critical for pro-rata distribution to work correctly across multiple pages.
    let claimed_quote = if is_first_page && progress.day_completed {
        // Validate that total_locked is provided (must be > 0 if investors exist)
        require!(total_locked_all_investors > 0, HonouraryError::MathOverflow);

        // Claim fees from honorary position
        let vault_key = ctx.accounts.vault.key();
        let bump_slice = [ctx.accounts.position_owner.bump];
        let signer_seeds = [
            VAULT_SEED,
            vault_key.as_ref(),
            INVESTOR_FEE_POS_OWNER_SEED,
            &bump_slice,
        ];
        let signer_seeds_ref = &[&signer_seeds[..]];

        let claimed = claim_position_fees_quote_only(
            &ctx.accounts.position,
            &ctx.accounts.pool,
            &ctx.accounts.position_owner.to_account_info(),
            &ctx.accounts.quote_mint.to_account_info(),
            &ctx.accounts.base_mint.to_account_info(),
            &ctx.accounts.quote_vault.to_account_info(),
            &ctx.accounts.base_vault.to_account_info(),
            &ctx.accounts.treasury_ata.to_account_info(),
            &ctx.accounts.base_treasury_ata.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.token_program,
            &ctx.accounts.pool_authority,
            &ctx.accounts.position_nft_account.to_account_info(),
            &ctx.accounts.event_authority,
            &ctx.accounts.cp_amm_program_account,
            &ctx.accounts.cp_amm_program.to_account_info(),
            signer_seeds_ref
        )?;

        // Reset progress for new day with total locked amount
        progress.start_new_day(current_time, claimed, total_locked_all_investors);

        // Update position owner stats
        ctx.accounts.position_owner.total_fees_claimed += claimed;

        emit!(QuoteFeesClaimed {
            vault: ctx.accounts.vault.key(),
            amount: claimed,
            timestamp: current_time,
        });

        claimed
    } else {
        progress.current_day_total_claimed
    };

    // Parse investor data from remaining accounts (inline to avoid lifetime issues)
    let start_idx = (page_start * 2) as usize; // 2 accounts per investor (stream + ATA)
    let end_idx = ((page_start + page_size) * 2) as usize;

    require!(end_idx <= ctx.remaining_accounts.len(), HonouraryError::InvalidPagination);

    let mut individual_locked = Vec::new();

    // Process each investor in this page to get their individual locked amounts
    for i in (start_idx..end_idx).step_by(2) {
        let stream_account = &ctx.remaining_accounts[i];
        let _investor_ata = &ctx.remaining_accounts[i + 1];

        // Read locked amount from this stream
        let locked = crate::integrations::streamflow::read_locked_amount_from_stream(
            stream_account,
            current_time
        )?;

        individual_locked.push(locked);
    }

    // CRITICAL FIX: Use total locked across ALL investors (stored in progress), not just this page
    // This ensures consistent pro-rata calculation across all pages
    let total_locked_all_investors = progress.current_day_total_locked_all;

    // Calculate distributions for this page using TOTAL locked amount
    let eligible_share_bps = policy.calculate_eligible_investor_share(total_locked_all_investors);
    let total_investor_fee = calculate_investor_fee_amount(claimed_quote, eligible_share_bps)?;

    let mut page_distributed = 0u64;
    let mut page_dust = 0u64;

    // Distribute to each investor in this page
    for (idx, locked_amount) in individual_locked.iter().enumerate() {
        let i = start_idx + idx * 2;
        let _stream_account = &ctx.remaining_accounts[i];
        let investor_ata = &ctx.remaining_accounts[i + 1];

        // Calculate individual payout using TOTAL locked across all investors
        let individual_payout = calculate_individual_payout(
            total_investor_fee,
            *locked_amount,
            total_locked_all_investors // Use total across ALL investors, not just this page
        )?;

        let (final_payout, dust) = apply_dust_threshold(
            individual_payout,
            policy.min_payout_lamports
        );

        if final_payout > 0 {
            // Check daily cap
            let allowed_payout = check_daily_cap(
                progress.current_day_distributed,
                final_payout,
                policy.daily_cap_lamports
            )?;

            if allowed_payout > 0 {
                // Transfer to investor
                let vault_key = ctx.accounts.vault.key();
                let bump_slice = [ctx.accounts.position_owner.bump];
                let signer_seeds = [
                    VAULT_SEED,
                    vault_key.as_ref(),
                    INVESTOR_FEE_POS_OWNER_SEED,
                    &bump_slice,
                ];
                let signer_seeds_ref = &[&signer_seeds[..]];

                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.treasury_ata.to_account_info(),
                            mint: ctx.accounts.quote_mint.to_account_info(),
                            to: investor_ata.to_account_info(),
                            authority: ctx.accounts.position_owner.to_account_info(),
                        },
                        signer_seeds_ref
                    ),
                    allowed_payout,
                    ctx.accounts.quote_mint.decimals
                )?;

                page_distributed += allowed_payout;
            }

            page_dust += final_payout.saturating_sub(allowed_payout);
        } else {
            page_dust += dust;
        }
    }

    // Update progress
    progress.current_day_distributed += page_distributed;
    progress.current_day_carry_over += page_dust;
    progress.pagination_cursor = page_start + page_size;
    progress.total_investor_distributed += page_distributed;

    // Check if this is the final page
    // Final page is when we've processed all remaining accounts
    let is_final_page = end_idx >= ctx.remaining_accounts.len();

    if is_final_page {
        // Send remainder to creator
        let remainder = calculate_creator_remainder(
            claimed_quote,
            progress.current_day_distributed,
            progress.current_day_carry_over
        )?;

        if remainder > 0 {
            let vault_key = ctx.accounts.vault.key();
            let bump_slice = [ctx.accounts.position_owner.bump];
            let signer_seeds = [
                VAULT_SEED,
                vault_key.as_ref(),
                INVESTOR_FEE_POS_OWNER_SEED,
                &bump_slice,
            ];
            let signer_seeds_ref = &[&signer_seeds[..]];

            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.treasury_ata.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.creator_ata.to_account_info(),
                        authority: ctx.accounts.position_owner.to_account_info(),
                    },
                    signer_seeds_ref
                ),
                remainder,
                ctx.accounts.quote_mint.decimals
            )?;
        }

        // Complete the day
        progress.complete_day(remainder);

        emit!(CreatorPayoutDayClosed {
            vault: ctx.accounts.vault.key(),
            creator_amount: remainder,
            total_distributed: progress.current_day_distributed,
            timestamp: current_time,
        });
    }

    // Emit page completion event
    emit!(InvestorPayoutPage {
        vault: ctx.accounts.vault.key(),
        page_start,
        page_size,
        investors_paid: individual_locked.len() as u32,
        total_paid: page_distributed,
        dust_carried: page_dust,
        timestamp: current_time,
    });

    Ok(())
}
