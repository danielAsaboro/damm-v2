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
#[instruction(page_start: u32, page_size: u32, total_locked_all_investors: u64, is_final_page: bool)]
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
    total_locked_all_investors: u64,
    is_final_page: bool
) -> Result<()> {
    // Note: Compute budget must be set by the client via ComputeBudgetProgram.setComputeUnitLimit()
    // We need ~400K units for Streamflow SDK calculations with floating-point operations

    let progress = &mut ctx.accounts.progress;
    let policy = &ctx.accounts.policy;
    let current_time = Clock::get()?.unix_timestamp;

    // Validate pagination parameters
    require!(page_size > 0 && page_size <= MAX_PAGE_SIZE, HonouraryError::InvalidPagination);

    // Check if we can distribute (24-hour window or continuing same day)
    require!(progress.can_distribute(current_time), HonouraryError::CrankWindowNotReached);

    // Enforce idempotent behavior: if page already processed, return early (no-op)
    // This allows safe retries without double-payment
    // Only allow backward pagination when starting a new day (day_completed=true)
    if !progress.day_completed && page_start < progress.pagination_cursor {
        // Page already processed - return success without doing anything
        // This prevents double-payment while allowing retry logic to work smoothly
        return Ok(());
    }

    let is_first_page = page_start == 0 || progress.day_completed;

    // If first page of new day, claim fees and store TOTAL locked across ALL investors
    // NOTE: total_locked_all_investors must be calculated off-chain by the caller
    // by summing locked amounts from ALL investor Streamflow accounts, not just the current page.
    // This is critical for pro-rata distribution to work correctly across multiple pages.
    let claimed_quote = if is_first_page && progress.day_completed {
        // Note: total_locked_all_investors can be 0 if all tokens are fully unlocked
        // In this case, all fees go to creator (handled by calculation logic)

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
    // Per bounty spec line 28: pagination means we only receive accounts for THIS page
    // remaining_accounts contains exactly page_size * 2 accounts (stream + ATA per investor)
    let start_idx = 0; // Always start at beginning of provided page slice
    let end_idx = (page_size * 2) as usize; // End at page_size worth of investors

    require!(
        ctx.remaining_accounts.len() == end_idx,
        HonouraryError::InvalidPagination
    );

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

    // CRITICAL FIX: Handle accumulated dust from previous pages within the same day
    // Bounty spec line 99: "carry dust to later pages/day"
    // If accumulated dust exceeds the minimum payout threshold, distribute it pro-rata to this page
    let carry_over_from_previous_pages = progress.current_day_carry_over;
    let mut carry_over_distributed = 0u64;

    if carry_over_from_previous_pages >= policy.min_payout_lamports {
        // Distribute accumulated dust pro-rata to investors on this page
        // Calculate this page's share of total locked
        let page_locked: u64 = individual_locked.iter().sum();

        if total_locked_all_investors > 0 {
            let page_share = (carry_over_from_previous_pages as u128)
                .saturating_mul(page_locked as u128)
                .saturating_div(total_locked_all_investors as u128) as u64;

            carry_over_distributed = page_share;
            // This will be added to page_distributed after investor distributions
        }
    }

    // Reset carry_over - we'll set it to new dust at the end
    progress.current_day_carry_over = 0;

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
            // Check daily cap using CURRENT progress (updated incrementally)
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

                // CRITICAL FIX: Update progress.current_day_distributed immediately after each transfer
                // This ensures the daily cap check sees the cumulative amount for subsequent investors
                progress.current_day_distributed =
                    progress.current_day_distributed.saturating_add(allowed_payout);
                page_distributed = page_distributed.saturating_add(allowed_payout);
            }

            // Accumulate dust from cap-limited payouts
            page_dust = page_dust.saturating_add(final_payout.saturating_sub(allowed_payout));
        } else {
            page_dust = page_dust.saturating_add(dust);
        }
    }

    // Do NOT override with total_investor_fee; we must respect daily cap.
    // page_distributed already reflects the sum of actual transfers this page.
    // progress.current_day_distributed has already been updated incrementally in the loop above

    // Distribute accumulated dust if it exceeded threshold
    if carry_over_distributed > 0 {
        // Distribute proportionally to investors on this page
        let page_locked: u64 = individual_locked.iter().sum();

        for (idx, locked_amount) in individual_locked.iter().enumerate() {
            if page_locked == 0 {
                break;
            }

            let investor_dust_share = (carry_over_distributed as u128)
                .saturating_mul(*locked_amount as u128)
                .saturating_div(page_locked as u128) as u64;

            if investor_dust_share > 0 {
                let i = start_idx + idx * 2;
                let investor_ata = &ctx.remaining_accounts[i + 1];

                // Transfer dust share to investor
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
                    investor_dust_share,
                    ctx.accounts.quote_mint.decimals
                )?;

                progress.current_day_distributed =
                    progress.current_day_distributed.saturating_add(investor_dust_share);
                page_distributed = page_distributed.saturating_add(investor_dust_share);
            }
        }

        // Subtract distributed dust from carry_over pool
        // Any remainder (due to rounding) stays in carry_over for next page
        let remaining_carry_over = carry_over_from_previous_pages.saturating_sub(carry_over_distributed);
        page_dust = page_dust.saturating_add(remaining_carry_over);
    } else {
        // Carry over didn't meet threshold, add it to new dust
        page_dust = page_dust.saturating_add(carry_over_from_previous_pages);
    }

    // Update carry_over with accumulated dust from this page
    progress.current_day_carry_over = page_dust;
    progress.pagination_cursor = page_start + page_size;
    progress.total_investor_distributed += page_distributed;

    // On final page, close out the day and send remainder to creator
    // Caller signals final page via is_final_page parameter
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
