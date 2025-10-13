#![allow(deprecated)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod integrations;
pub mod state;
pub mod utils;
pub mod cp_amm_types;

pub use constants::*;
pub use error::*;
pub use events::*;
pub use instructions::*;
pub use state::*;
pub use utils::*;

declare_id!("5B57SJ3g2YoNXUpsZqqjEQkRSxyKtVTQRXdgAirz6bio");

#[program]
pub mod fee_router {
    use super::*;

    /// Initialize an honorary position that accrues only quote token fees
    pub fn initialize_honorary_position(ctx: Context<InitializeHonoraryPosition>) -> Result<()> {
        instructions::handle_initialize_honorary_position(ctx)
    }

    /// Setup distribution policy and parameters
    pub fn setup_policy(ctx: Context<SetupPolicy>, params: PolicyParams) -> Result<()> {
        instructions::handle_setup_policy(ctx, params)
    }

    /// Crank the 24-hour distribution system (paginated)
    pub fn crank_distribution<'info>(
        ctx: Context<'_, '_, '_, 'info, CrankDistribution<'info>>,
        page_start: u32,
        page_size: u32,
        total_locked_all_investors: u64
    ) -> Result<()> {
        instructions::handle_crank_distribution(
            ctx,
            page_start,
            page_size,
            total_locked_all_investors
        )
    }
}
