use anchor_lang::prelude::*;
use crate::cp_amm_types::Pool;
use crate::error::HonouraryError;

/// Validate that a pool is configured for quote-only fee collection
pub fn validate_quote_only_pool(
    pool: &Pool,
    expected_quote_mint: &Pubkey,
) -> Result<()> {
    // Check if pool is configured to collect fees only in token B
    // Based on the pool.rs code: 0 = both tokens, 1 = only token A, 2 = only token B
    match pool.collect_fee_mode {
        2 => {
            // Only token B mode - Token B should be our quote mint
            require_keys_eq!(
                pool.token_b_mint,
                *expected_quote_mint,
                HonouraryError::QuoteOnlyValidationFailed
            );
        }
        1 => {
            // Only token A mode - Token A should be our quote mint
            require_keys_eq!(
                pool.token_a_mint,
                *expected_quote_mint,
                HonouraryError::QuoteOnlyValidationFailed
            );
        }
        0 => {
            // Both token mode - we don't want this
            return Err(HonouraryError::QuoteOnlyValidationFailed.into());
        }
        _ => {
            // Invalid mode
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
        2 => Ok(pool.token_b_mint),  // Only token B
        1 => Ok(pool.token_a_mint),  // Only token A
        0 => {
            // Both token mode - we need additional logic to determine
            // which token should be treated as quote. This might depend
            // on the specific pool configuration or external parameters.
            Err(HonouraryError::InvalidPoolConfiguration.into())
        }
        _ => Err(HonouraryError::InvalidPoolConfiguration.into())
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