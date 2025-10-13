use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct InvestorFeePositionOwner {
    /// The vault this position is associated with
    pub vault: Pubkey,
    
    /// The DAMM v2 pool this position belongs to
    pub pool: Pubkey,
    
    /// The NFT mint for this position
    pub position_mint: Pubkey,
    
    /// The quote token mint (the only token we collect fees in)
    pub quote_mint: Pubkey,
    
    /// The actual position account created in cp-amm
    pub position_account: Pubkey,
    
    /// Bump seed for PDA derivation
    pub bump: u8,
    
    /// Creation timestamp
    pub created_at: i64,
    
    /// Total fees claimed to date
    pub total_fees_claimed: u64,
}

impl InvestorFeePositionOwner {
    pub const SEEDS_PREFIX: &'static [u8] = crate::constants::INVESTOR_FEE_POS_OWNER_SEED;
    
    pub fn seeds<'a>(&'a self) -> [&'a [u8]; 4] {
        [
            crate::constants::VAULT_SEED,
            self.vault.as_ref(),
            Self::SEEDS_PREFIX,
            std::slice::from_ref(&self.bump),
        ]
    }
}