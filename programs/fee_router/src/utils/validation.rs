use anchor_lang::prelude::*;
use crate::cp_amm_types::Pool;
use crate::error::HonouraryError;

/// Validate that a pool is configured for quote-only fee collection
pub fn validate_quote_only_pool(
    pool: &Pool,
    expected_quote_mint: &Pubkey,
) -> Result<()> {
    // Check if pool is configured to collect fees only in one token
    // Based on CP-AMM's CollectFeeMode enum and FeeMode logic:
    // - 0 = BothToken: collects fees in both tokens (REJECT)
    // - 1 = OnlyB: collects fees only in tokenB (ACCEPT if quote_mint == tokenB)
    // The FeeMode logic shows that OnlyB mode collects fees on the OUTPUT token (tokenB)
    // Note: There is no mode 2, only 0 and 1 exist in the actual CP-AMM code
    match pool.collect_fee_mode {
        1 => {
            // OnlyB mode - collects fees only in tokenB (the output token)
            // Token B should be our quote mint
            require_keys_eq!(
                pool.token_b_mint,
                *expected_quote_mint,
                HonouraryError::QuoteOnlyValidationFailed
            );
        }
        0 => {
            // BothToken mode - we don't want this (not quote-only)
            return Err(HonouraryError::QuoteOnlyValidationFailed.into());
        }
        _ => {
            // Invalid mode (mode 2+ doesn't exist in CP-AMM)
            return Err(HonouraryError::InvalidPoolConfiguration.into());
        }
    }
    
    // Additional validation: check pool status is enabled (0 = enabled, 1 = disabled based on comment)
    require!(
        pool.pool_status == 0,
        HonouraryError::InvalidPoolConfiguration
    );
    
    Ok(())
}

/// Determine which token is the quote token based on pool configuration
pub fn determine_quote_mint(pool: &Pool) -> Result<Pubkey> {
    match pool.collect_fee_mode {
        1 => Ok(pool.token_b_mint),  // OnlyB mode - collects in tokenB
        0 => {
            // BothToken mode - not supported for quote-only pools
            Err(HonouraryError::InvalidPoolConfiguration.into())
        }
        _ => {
            // Invalid mode (mode 2+ doesn't exist)
            Err(HonouraryError::InvalidPoolConfiguration.into())
        }
    }
}

/// Validate position ownership by program PDA
pub fn validate_position_ownership(
    position_owner_pda: &Pubkey,
    actual_position_owner: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *position_owner_pda,
        *actual_position_owner,
        HonouraryError::InvalidPositionOwnership
    );
    Ok(())
}

/// Pre-flight validation before creating position
pub fn preflight_position_validation(
    pool: &Pool,
    quote_mint: &Pubkey,
) -> Result<()> {
    // Comprehensive validation to prevent any base token fee accrual
    validate_quote_only_pool(pool, quote_mint)?;
    
    // Check pool tick configuration if applicable
    // (Add specific tick/price validations based on DAMM v2 requirements)
    
    Ok(())
}