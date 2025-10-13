use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use crate::cp_amm_types::Pool;
use crate::{
    constants::*,
    state::{InvestorFeePositionOwner},
    utils::{validation::validate_quote_only_pool, pda::position_owner_signer_seeds},
    integrations::cp_amm::create_honorary_position,
    events::HonoraryPositionInitialized,
};

#[derive(Accounts)]
pub struct InitializeHonoraryPosition<'info> {
    /// Payer for account creation
    #[account(mut)]
    pub payer: Signer<'info>,
    
    /// Vault identifier (can be any account, used as seed)
    /// CHECK: Used only as PDA seed
    pub vault: UncheckedAccount<'info>,
    
    /// PDA that will own the honorary position
    #[account(
        init,
        seeds = [
            VAULT_SEED,
            vault.key().as_ref(),
            INVESTOR_FEE_POS_OWNER_SEED
        ],
        bump,
        payer = payer,
        space = 8 + InvestorFeePositionOwner::INIT_SPACE
    )]
    pub position_owner_pda: Account<'info, InvestorFeePositionOwner>,
    
    /// The DAMM v2 pool to create position in
    pub pool: Account<'info, Pool>,
    
    /// Quote mint (the only token we collect fees in)
    pub quote_mint: InterfaceAccount<'info, Mint>,
    
    /// Base mint (should not collect fees in this token)
    pub base_mint: InterfaceAccount<'info, Mint>,
    
    /// Position NFT mint (will be created)
    #[account(
        init,
        signer,
        payer = payer,
        mint::decimals = 0,
        mint::authority = position_owner_pda,
        mint::token_program = token_program
    )]
    pub position_nft_mint: InterfaceAccount<'info, Mint>,
    
    /// Position NFT token account
    #[account(
        init,
        payer = payer,
        associated_token::mint = position_nft_mint,
        associated_token::authority = position_owner_pda,
        associated_token::token_program = token_program
    )]
    pub position_nft_account: InterfaceAccount<'info, TokenAccount>,
    
    /// Position account (will be created by CP-AMM)
    /// CHECK: Created by CP-AMM CPI
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    
    /// Pool authority from CP-AMM
    /// CHECK: CP-AMM pool authority PDA
    pub pool_authority: UncheckedAccount<'info>,
    
    // Program accounts
    pub cp_amm_program: Program<'info, crate::cp_amm_types::CpAmm>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_honorary_position(
    ctx: Context<InitializeHonoraryPosition>,
) -> Result<()> {
    let pool = &ctx.accounts.pool;
    
    // Critical validation: ensure pool only collects fees in quote token
    validate_quote_only_pool(&pool, &ctx.accounts.quote_mint.key())?;
    
    // Initialize position owner PDA
    let position_owner = &mut ctx.accounts.position_owner_pda;
    position_owner.vault = ctx.accounts.vault.key();
    position_owner.pool = ctx.accounts.pool.key();
    position_owner.position_mint = ctx.accounts.position_nft_mint.key();
    position_owner.quote_mint = ctx.accounts.quote_mint.key();
    position_owner.position_account = ctx.accounts.position.key();
    position_owner.bump = ctx.bumps.position_owner_pda;
    position_owner.created_at = Clock::get()?.unix_timestamp;
    position_owner.total_fees_claimed = 0;
    
    // Create honorary position through CP-AMM CPI
    let vault_key = ctx.accounts.vault.key();
    let bump_array = [ctx.bumps.position_owner_pda];
    let signer_seeds = position_owner_signer_seeds(
        &vault_key,
        &bump_array,
    );
    let signer_seeds_ref = &[&signer_seeds[..]];
    
    // Note: You may need to adjust this CPI call based on CP-AMM's exact interface
    create_honorary_position(
        &ctx.accounts.pool,
        &ctx.accounts.position_owner_pda.to_account_info(),
        &ctx.accounts.position_nft_mint.to_account_info(),
        &ctx.accounts.position,
        &ctx.accounts.position_nft_account.to_account_info(),
        &ctx.accounts.pool_authority,
        &ctx.accounts.cp_amm_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        signer_seeds_ref,
    )?;
    
    // Emit initialization event
    emit!(HonoraryPositionInitialized {
        vault: ctx.accounts.vault.key(),
        pool: ctx.accounts.pool.key(),
        position: ctx.accounts.position.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        position_owner: ctx.accounts.position_owner_pda.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    
    Ok(())
}