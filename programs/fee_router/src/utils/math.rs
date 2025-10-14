use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::HonouraryError;

/// Calculate eligible investor share based on locked token percentage
pub fn calculate_eligible_investor_share_bps(
    locked_total: u64,
    y0_total_allocation: u64,
    max_investor_share_bps: u16
) -> Result<u16> {
    if y0_total_allocation == 0 {
        return Ok(0);
    }

    // Calculate locked fraction: locked_total / Y0
    let locked_fraction = (locked_total as u128)
        .checked_mul(BASIS_POINTS_DIVISOR as u128)
        .ok_or(HonouraryError::MathOverflow)?
        .checked_div(y0_total_allocation as u128)
        .ok_or(HonouraryError::MathOverflow)?;

    // Cap at 100% (BASIS_POINTS_DIVISOR)
    let locked_fraction_bps = std::cmp::min(locked_fraction, BASIS_POINTS_DIVISOR as u128) as u16;

    // Return minimum of configured max and actual locked percentage
    Ok(std::cmp::min(max_investor_share_bps, locked_fraction_bps))
}

/// Calculate total investor fee amount from claimed quote fees
pub fn calculate_investor_fee_amount(
    claimed_quote: u64,
    eligible_investor_share_bps: u16
) -> Result<u64> {
    (claimed_quote as u128)
        .checked_mul(eligible_investor_share_bps as u128)
        .ok_or(HonouraryError::MathOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR as u128)
        .ok_or(HonouraryError::MathOverflow)?
        .try_into()
        .map_err(|_| HonouraryError::MathOverflow.into())
}

/// Calculate individual investor payout based on their locked amount
pub fn calculate_individual_payout(
    total_investor_fee: u64,
    individual_locked: u64,
    total_locked: u64
) -> Result<u64> {
    if total_locked == 0 {
        return Ok(0);
    }

    (total_investor_fee as u128)
        .checked_mul(individual_locked as u128)
        .ok_or(HonouraryError::MathOverflow)?
        .checked_div(total_locked as u128)
        .ok_or(HonouraryError::MathOverflow)?
        .try_into()
        .map_err(|_| HonouraryError::MathOverflow.into())
}

/// Apply dust threshold and minimum payout rules
pub fn apply_dust_threshold(calculated_amount: u64, min_payout_threshold: u64) -> (u64, u64) {
    if calculated_amount >= min_payout_threshold {
        (calculated_amount, 0) // (payout, dust)
    } else {
        (0, calculated_amount) // (payout, dust)
    }
}

/// Calculate creator remainder after investor distributions
/// Note: carry_over is dust that should be carried to NEXT distribution, not given to creator
pub fn calculate_creator_remainder(
    total_claimed: u64,
    total_investor_distributed: u64,
    carry_over: u64
) -> Result<u64> {
    // Creator gets: total_claimed - investor_distributed - carry_over
    // Carry-over goes to next day's distribution pool
    let after_investors = total_claimed.saturating_sub(total_investor_distributed);
    Ok(after_investors.saturating_sub(carry_over))
}

/// Validate daily cap constraints
pub fn check_daily_cap(
    already_distributed: u64,
    proposed_distribution: u64,
    daily_cap: Option<u64>
) -> Result<u64> {
    if let Some(cap) = daily_cap {
        let total_would_be = already_distributed
            .checked_add(proposed_distribution)
            .ok_or(HonouraryError::MathOverflow)?;

        if total_would_be > cap {
            // Return the amount that can still be distributed
            Ok(cap.saturating_sub(already_distributed))
        } else {
            Ok(proposed_distribution)
        }
    } else {
        Ok(proposed_distribution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eligible_share_calculation() {
        // Test case: 50% locked, max 30% share
        let result = calculate_eligible_investor_share_bps(5000, 10000, 3000).unwrap();
        assert_eq!(result, 3000); // Should return max share (30%)

        // Test case: 20% locked, max 30% share
        let result = calculate_eligible_investor_share_bps(2000, 10000, 3000).unwrap();
        assert_eq!(result, 2000); // Should return locked percentage (20%)
    }

    #[test]
    fn test_dust_threshold() {
        let (payout, dust) = apply_dust_threshold(500, 1000);
        assert_eq!(payout, 0);
        assert_eq!(dust, 500);

        let (payout, dust) = apply_dust_threshold(1500, 1000);
        assert_eq!(payout, 1500);
        assert_eq!(dust, 0);
    }
}
