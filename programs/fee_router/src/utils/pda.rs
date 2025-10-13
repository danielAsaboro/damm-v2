use anchor_lang::prelude::*;
use crate::constants::*;

/// Derive the investor fee position owner PDA
pub fn derive_investor_fee_position_owner_pda(
    vault: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            VAULT_SEED,
            vault.as_ref(),
            INVESTOR_FEE_POS_OWNER_SEED,
        ],
        program_id,
    )
}

/// Derive the policy PDA
pub fn derive_policy_pda(
    vault: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            POLICY_SEED,
            vault.as_ref(),
        ],
        program_id,
    )
}

/// Derive the progress tracking PDA
pub fn derive_progress_pda(
    vault: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            PROGRESS_SEED,
            vault.as_ref(),
        ],
        program_id,
    )
}

/// Derive the treasury ATA PDA
pub fn derive_treasury_pda(
    vault: &Pubkey,
    quote_mint: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            TREASURY_SEED,
            vault.as_ref(),
            quote_mint.as_ref(),
        ],
        program_id,
    )
}

/// Generate signer seeds for position owner PDA
pub fn position_owner_signer_seeds<'a>(
    vault: &'a Pubkey,
    bump: &'a [u8; 1],
) -> [&'a [u8]; 4] {
    [
        VAULT_SEED,
        vault.as_ref(),
        INVESTOR_FEE_POS_OWNER_SEED,
        bump,
    ]
}