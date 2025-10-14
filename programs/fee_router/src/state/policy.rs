use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyParams {
    pub creator_wallet: Pubkey,
    pub investor_fee_share_bps: u16, // Basis points (0-10000)
    pub daily_cap_lamports: Option<u64>,
    pub min_payout_lamports: u64,
    pub y0_total_allocation: u64, // Total tokens minted at TGE
    pub total_investors: u32, // Total number of investors for pagination validation
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    /// The vault this policy applies to
    pub vault: Pubkey,
    
    /// Creator wallet to receive remainder fees
    pub creator_wallet: Pubkey,
    
    /// Investor fee share in basis points (0-10000)
    /// e.g., 3000 = 30% goes to investors
    pub investor_fee_share_bps: u16,
    
    /// Optional daily distribution cap in lamports
    pub daily_cap_lamports: Option<u64>,
    
    /// Minimum payout threshold in lamports
    pub min_payout_lamports: u64,
    
    /// Total investor allocation minted at TGE (Y0)
    pub y0_total_allocation: u64,

    /// Total number of investors (for pagination validation)
    pub total_investors: u32,

    /// PDA bump seed
    pub bump: u8,

    /// Policy creation timestamp
    pub created_at: i64,

    /// Policy last updated timestamp
    pub updated_at: i64,
}

impl Policy {
    pub const SEEDS_PREFIX: &'static [u8] = crate::constants::POLICY_SEED;
    
    pub fn seeds<'a>(&'a self) -> [&'a [u8]; 3] {
        [
            Self::SEEDS_PREFIX,
            self.vault.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }
    
    /// Calculate eligible investor share based on locked percentage
    pub fn calculate_eligible_investor_share(&self, locked_total: u64) -> u16 {
        if self.y0_total_allocation == 0 {
            return 0;
        }
        
        let locked_fraction = (locked_total as u128 * crate::constants::BASIS_POINTS_DIVISOR as u128) 
            / self.y0_total_allocation as u128;
        let locked_fraction = std::cmp::min(locked_fraction, crate::constants::BASIS_POINTS_DIVISOR as u128) as u16;
        
        std::cmp::min(self.investor_fee_share_bps, locked_fraction)
    }
}