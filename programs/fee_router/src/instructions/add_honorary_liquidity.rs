use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ instruction::AccountMeta, program::invoke_signed };
use anchor_spl::token_interface::{
    TokenAccount,
    TokenInterface,
    Mint,
    transfer_checked,
    TransferChecked,
};
use crate::cp_amm_types::{ Pool, Position };
use crate::{
    constants::*,
    state::InvestorFeePositionOwner,
    utils::pda::position_owner_signer_seeds,
    error::HonouraryError,
};

#[derive(Accounts)]
pub struct AddHonoraryLiquidity<'info> {
    /// Funder who provides the tokens
    #[account(mut)]
    pub funder: Signer<'info>,

    /// Vault identifier
    /// CHECK: Used as PDA seed
    pub vault: UncheckedAccount<'info>,

    /// Position owner PDA (owns the honorary position)
    #[account(
        seeds = [VAULT_SEED, vault.key().as_ref(), INVESTOR_FEE_POS_OWNER_SEED],
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
    #[account(mut, constraint = pool.key() == position_owner.pool)]
    pub pool: Box<Account<'info, Pool>>,

    /// Position NFT account
    #[account(token::mint = position_owner.position_mint, token::authority = position_owner)]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Quote mint
    #[account(constraint = quote_mint.key() == position_owner.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,

    /// Base mint
    pub base_mint: InterfaceAccount<'info, Mint>,

    /// Quote vault from pool
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Base vault from pool
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Funder's quote token account
    #[account(mut)]
    pub funder_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Funder's base token account
    #[account(mut)]
    pub funder_base_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Program-owned treasury for quote tokens (PDA-owned intermediate account)
    #[account(
        mut,
        seeds = [TREASURY_SEED, vault.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = position_owner
    )]
    pub quote_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Program-owned treasury for base tokens (PDA-owned intermediate account)
    #[account(
        mut,
        seeds = [TREASURY_SEED, vault.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = position_owner
    )]
    pub base_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    // Program accounts
    pub cp_amm_program: Program<'info, crate::cp_amm_types::CpAmm>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,

    /// Event authority PDA for CP-AMM
    /// CHECK: PDA derived with seeds ["__event_authority"]
    pub event_authority: UncheckedAccount<'info>,
}

pub fn handle_add_honorary_liquidity(
    ctx: Context<AddHonoraryLiquidity>,
    liquidity_delta: u128,
    token_a_amount_threshold: u64,
    token_b_amount_threshold: u64
) -> Result<()> {
    msg!("Adding liquidity to honorary position");

    require!(liquidity_delta > 0, HonouraryError::MathOverflow);

    // Step 1: Transfer tokens from funder to PDA-owned treasury accounts
    // This is necessary because CP-AMM's add_liquidity requires the owner (PDA in our case)
    // to have authority over the token accounts being deposited

    // Transfer quote tokens
    transfer_checked(
        CpiContext::new(
            ctx.accounts.quote_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_quote_account.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx.accounts.quote_treasury.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            }
        ),
        token_a_amount_threshold, // Use threshold as max amount to transfer
        ctx.accounts.quote_mint.decimals
    )?;

    // Transfer base tokens
    transfer_checked(
        CpiContext::new(
            ctx.accounts.base_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_base_account.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.base_treasury.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            }
        ),
        token_b_amount_threshold, // Use threshold as max amount to transfer
        ctx.accounts.base_mint.decimals
    )?;

    // Step 2: Prepare signer seeds for PDA
    let vault_key = ctx.accounts.vault.key();
    let bump_slice = [ctx.accounts.position_owner.bump];
    let signer_seeds = position_owner_signer_seeds(&vault_key, &bump_slice);
    let signer_seeds_ref = &[&signer_seeds[..]];

    // Determine account ordering based on pool's token layout
    let quote_is_token_a = ctx.accounts.pool.token_a_mint == ctx.accounts.quote_mint.key();

    // Use treasury accounts (PDA-owned) for add_liquidity
    let (token_a_account, token_b_account) = if quote_is_token_a {
        (&ctx.accounts.quote_treasury, &ctx.accounts.base_treasury)
    } else {
        (&ctx.accounts.base_treasury, &ctx.accounts.quote_treasury)
    };

    let (token_a_vault, token_b_vault) = if quote_is_token_a {
        (&ctx.accounts.quote_vault, &ctx.accounts.base_vault)
    } else {
        (&ctx.accounts.base_vault, &ctx.accounts.quote_vault)
    };

    let (token_a_mint, token_b_mint) = if quote_is_token_a {
        (&ctx.accounts.quote_mint, &ctx.accounts.base_mint)
    } else {
        (&ctx.accounts.base_mint, &ctx.accounts.quote_mint)
    };

    let (token_a_program, token_b_program) = if quote_is_token_a {
        (&ctx.accounts.quote_token_program, &ctx.accounts.base_token_program)
    } else {
        (&ctx.accounts.base_token_program, &ctx.accounts.quote_token_program)
    };

    // Step 3: Build CP-AMM add_liquidity instruction data
    // Discriminator from CP-AMM IDL
    let mut instruction_data = vec![181, 157, 89, 67, 143, 182, 52, 72];

    // Serialize AddLiquidityParameters struct
    instruction_data.extend_from_slice(&liquidity_delta.to_le_bytes());
    instruction_data.extend_from_slice(&token_a_amount_threshold.to_le_bytes());
    instruction_data.extend_from_slice(&token_b_amount_threshold.to_le_bytes());

    // Step 4: Call CP-AMM add_liquidity via CPI with PDA as the owner
    // The PDA owns both the position NFT and the treasury token accounts,
    // so it can sign for adding liquidity from the treasury accounts
    invoke_signed(
        &(anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.cp_amm_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.pool.key(), false),
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(token_a_account.key(), false), // Treasury account (PDA-owned)
                AccountMeta::new(token_b_account.key(), false), // Treasury account (PDA-owned)
                AccountMeta::new(token_a_vault.key(), false),
                AccountMeta::new(token_b_vault.key(), false),
                AccountMeta::new_readonly(token_a_mint.key(), false),
                AccountMeta::new_readonly(token_b_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_nft_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_owner.key(), true), // PDA signs (owns NFT & treasury)
                AccountMeta::new_readonly(token_a_program.key(), false),
                AccountMeta::new_readonly(token_b_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false), // CP-AMM event authority
                AccountMeta::new_readonly(ctx.accounts.cp_amm_program.key(), false), // CP-AMM program
            ],
            data: instruction_data,
        }),
        &[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.position.to_account_info(),
            token_a_account.to_account_info(),
            token_b_account.to_account_info(),
            token_a_vault.to_account_info(),
            token_b_vault.to_account_info(),
            token_a_mint.to_account_info(),
            token_b_mint.to_account_info(),
            ctx.accounts.position_nft_account.to_account_info(),
            ctx.accounts.position_owner.to_account_info(),
            token_a_program.to_account_info(),
            token_b_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(), // CP-AMM event authority
            ctx.accounts.cp_amm_program.to_account_info(), // CP-AMM program
        ],
        signer_seeds_ref
    )?;

    msg!("Successfully added {} liquidity to honorary position", liquidity_delta);

    Ok(())
}
