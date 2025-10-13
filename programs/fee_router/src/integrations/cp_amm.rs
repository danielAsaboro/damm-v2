use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ instruction::AccountMeta, program::invoke_signed };
use anchor_spl::token_interface::{ TokenAccount, TokenInterface };
use crate::cp_amm_types::{ Pool, Position, CreatePositionAccounts };
use crate::error::HonouraryError;

/// Create honorary position through CP-AMM CPI
pub fn create_honorary_position<'info>(
    pool: &Account<'info, Pool>,
    position_owner_pda: &AccountInfo<'info>,
    position_nft_mint: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_nft_account: &AccountInfo<'info>,
    pool_authority: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
    cp_amm_program_account: &AccountInfo<'info>,
    cp_amm_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]]
) -> Result<()> {
    msg!("Creating honorary position through CP-AMM CPI");

    // Build the CP-AMM create_position instruction
    let _create_position_accounts = CreatePositionAccounts {
        owner: position_owner_pda.clone(),
        position_nft_mint: position_nft_mint.clone(),
        position_nft_account: position_nft_account.clone(),
        pool: pool.to_account_info(),
        position: position.clone(),
        pool_authority: pool_authority.clone(),
        payer: payer.clone(),
        token_program: token_program.clone(),
        system_program: system_program.clone(),
    };

    // Note: Using direct invoke_signed instead of CPI context for lower stack usage

    // Call CP-AMM create_position instruction
    // Discriminator calculated from SHA256("global:create_position")[0..8]
    let instruction_data = &[48, 215, 197, 153, 96, 203, 180, 133]; // create_position discriminator

    invoke_signed(
        &(anchor_lang::solana_program::instruction::Instruction {
            program_id: cp_amm_program.key(),
            accounts: [
                AccountMeta::new_readonly(position_owner_pda.key(), true), // owner - signer (PDA)
                AccountMeta::new(position_nft_mint.key(), true), // position_nft_mint - signer (will be init by CP-AMM)
                AccountMeta::new(position_nft_account.key(), false), // position_nft_account (will be init by CP-AMM)
                AccountMeta::new(pool.key(), false), // pool
                AccountMeta::new(position.key(), false), // position
                AccountMeta::new_readonly(pool_authority.key(), false), // pool_authority
                AccountMeta::new(payer.key(), true), // payer - signer
                AccountMeta::new_readonly(token_program.key(), false), // token_program
                AccountMeta::new_readonly(system_program.key(), false), // system_program
                AccountMeta::new_readonly(event_authority.key(), false), // event_authority
                AccountMeta::new_readonly(cp_amm_program_account.key(), false), // program (for event_authority)
            ].to_vec(),
            data: instruction_data.to_vec(),
        }),
        &[
            position_owner_pda.clone(),
            position_nft_mint.clone(),
            position_nft_account.clone(),
            pool.to_account_info(),
            position.clone(),
            pool_authority.clone(),
            payer.clone(),
            token_program.clone(),
            system_program.clone(),
            event_authority.clone(),
            cp_amm_program_account.clone(),
        ],
        signer_seeds
    )?;

    Ok(())
}

/// Claim fees from honorary position with quote-only validation
pub fn claim_position_fees_quote_only<'info>(
    position: &Account<'info, Position>,
    pool: &Account<'info, Pool>,
    position_owner_pda: &AccountInfo<'info>,
    quote_mint: &AccountInfo<'info>,
    base_mint: &AccountInfo<'info>,
    quote_vault: &AccountInfo<'info>,
    base_vault: &AccountInfo<'info>,
    treasury_ata: &AccountInfo<'info>,
    base_treasury_ata: &AccountInfo<'info>, // Should remain zero
    quote_token_program: &Interface<'info, TokenInterface>,
    base_token_program: &Interface<'info, TokenInterface>,
    pool_authority: &AccountInfo<'info>,
    position_nft_account: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
    cp_amm_program_account: &AccountInfo<'info>,
    cp_amm_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]]
) -> Result<u64> {
    // Record balance before claiming
    let treasury_before = {
        let account = TokenAccount::try_deserialize(&mut treasury_ata.try_borrow_data()?.as_ref())?;
        account.amount
    };

    let base_treasury_before = {
        let account = TokenAccount::try_deserialize(
            &mut base_treasury_ata.try_borrow_data()?.as_ref()
        )?;
        account.amount
    };

    // Claim position fees through CP-AMM CPI
    msg!("Claiming position fees from CP-AMM");

    // Determine account ordering based on pool's token layout
    // CP-AMM expects accounts in token_a/token_b order to match pool's has_one constraints
    let quote_is_token_a = pool.token_a_mint == quote_mint.key();

    let (token_a_treasury, token_b_treasury) = if quote_is_token_a {
        (treasury_ata, base_treasury_ata)
    } else {
        (base_treasury_ata, treasury_ata)
    };

    let (token_a_vault, token_b_vault) = if quote_is_token_a {
        (quote_vault, base_vault)
    } else {
        (base_vault, quote_vault)
    };

    let (token_a_mint, token_b_mint) = if quote_is_token_a {
        (quote_mint, base_mint)
    } else {
        (base_mint, quote_mint)
    };

    let (token_a_program, token_b_program) = if quote_is_token_a {
        (quote_token_program, base_token_program)
    } else {
        (base_token_program, quote_token_program)
    };

    // Note: Using direct invoke_signed for lower stack usage

    // Call CP-AMM claim_position_fee instruction
    // Discriminator calculated from SHA256("global:claim_position_fee")[0..8]
    let instruction_data = &[180, 38, 154, 17, 133, 33, 162, 211]; // claim_position_fee discriminator

    invoke_signed(
        &(anchor_lang::solana_program::instruction::Instruction {
            program_id: cp_amm_program.key(),
            accounts: [
                AccountMeta::new_readonly(pool_authority.key(), false),
                AccountMeta::new_readonly(pool.key(), false),
                AccountMeta::new(position.key(), false),
                AccountMeta::new(token_a_treasury.key(), false),
                AccountMeta::new(token_b_treasury.key(), false),
                AccountMeta::new(token_a_vault.key(), false),
                AccountMeta::new(token_b_vault.key(), false),
                AccountMeta::new_readonly(token_a_mint.key(), false),
                AccountMeta::new_readonly(token_b_mint.key(), false),
                AccountMeta::new_readonly(position_nft_account.key(), false),
                AccountMeta::new_readonly(position_owner_pda.key(), true),
                AccountMeta::new_readonly(token_a_program.key(), false),
                AccountMeta::new_readonly(token_b_program.key(), false),
                // Anchor #[event_cpi] requires these trailing accounts
                AccountMeta::new_readonly(event_authority.key(), false),
                AccountMeta::new_readonly(cp_amm_program_account.key(), false),
            ].to_vec(),
            data: instruction_data.to_vec(),
        }),
        &[
            pool_authority.clone(),
            pool.to_account_info(),
            position.to_account_info(),
            token_a_treasury.clone(),
            token_b_treasury.clone(),
            token_a_vault.clone(),
            token_b_vault.clone(),
            token_a_mint.clone(),
            token_b_mint.clone(),
            position_nft_account.clone(),
            position_owner_pda.clone(),
            token_a_program.to_account_info(),
            token_b_program.to_account_info(),
            event_authority.clone(),
            cp_amm_program_account.clone(),
        ],
        signer_seeds
    )?;

    // Verify only quote tokens were received
    let treasury_after = {
        let account = TokenAccount::try_deserialize(&mut treasury_ata.try_borrow_data()?.as_ref())?;
        account.amount
    };

    let base_treasury_after = {
        let account = TokenAccount::try_deserialize(
            &mut base_treasury_ata.try_borrow_data()?.as_ref()
        )?;
        account.amount
    };

    // Ensure no base tokens were received
    require_eq!(base_treasury_before, base_treasury_after, HonouraryError::BaseFeesDetected);

    // Calculate quote tokens received
    let quote_claimed = treasury_after
        .checked_sub(treasury_before)
        .ok_or(HonouraryError::MathOverflow)?;

    Ok(quote_claimed)
}
