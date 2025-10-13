use anchor_lang::prelude::*;

#[event]
pub struct HonoraryPositionInitialized {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub quote_mint: Pubkey,
    pub position_owner: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct PolicySetup {
    pub vault: Pubkey,
    pub creator_wallet: Pubkey,
    pub investor_fee_share_bps: u16,
    pub y0_total_allocation: u64,
    pub timestamp: i64,
}

#[event]
pub struct QuoteFeesClaimed {
    pub vault: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct InvestorPayoutPage {
    pub vault: Pubkey,
    pub page_start: u32,
    pub page_size: u32,
    pub investors_paid: u32,
    pub total_paid: u64,
    pub dust_carried: u64,
    pub timestamp: i64,
}

#[event]
pub struct CreatorPayoutDayClosed {
    pub vault: Pubkey,
    pub creator_amount: u64,
    pub total_distributed: u64,
    pub timestamp: i64,
}