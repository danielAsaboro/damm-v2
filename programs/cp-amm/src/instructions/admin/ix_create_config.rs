use crate::activation_handler::ActivationHandler;
use crate::assert_eq_admin;
use crate::constants::seeds::CONFIG_PREFIX;
use crate::event;
use crate::params::customizable_params::CustomizableParams;
use crate::state::config::Config;
use crate::state::pool_fees::PoolFees;
use crate::state::pool_fees::{validate_fee_fraction, PartnerInfo};
use crate::state::CollectFeeMode;
use crate::PoolError;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ConfigParameters {
    pub trade_fee_numerator: u64,
    pub protocol_fee_percent: u8,
    pub partner_fee_percent: u8,
    pub referral_fee_percent: u8,
    pub sqrt_min_price: u128,
    pub sqrt_max_price: u128,
    pub vault_config_key: Pubkey,
    pub pool_creator_authority: Pubkey,
    pub activation_type: u8,
    pub collect_fee_mode: CollectFeeMode,
    pub index: u64,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(config_parameters: ConfigParameters)]
pub struct CreateConfigCtx<'info> {
    #[account(
        init,
        seeds = [
            CONFIG_PREFIX.as_ref(),
            config_parameters.index.to_le_bytes().as_ref()
        ],
        bump,
        payer = admin,
        space = 8 + Config::INIT_SPACE
    )]
    pub config: AccountLoader<'info, Config>,

    #[account(mut, constraint = assert_eq_admin(admin.key()) @ PoolError::InvalidAdmin)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_config(
    ctx: Context<CreateConfigCtx>,
    config_parameters: ConfigParameters,
) -> Result<()> {
    let ConfigParameters {
        trade_fee_numerator,
        protocol_fee_percent,
        vault_config_key,
        pool_creator_authority,
        activation_type,
        partner_fee_percent,
        sqrt_min_price,
        sqrt_max_price,
        referral_fee_percent,
        collect_fee_mode,
        index,
    } = config_parameters;

    // only support price from 0 to u64::MAX now
    require!(
        sqrt_min_price == 0 && sqrt_max_price == u128::MAX,
        PoolError::InvalidPriceRange
    );

    let has_alpha_vault = vault_config_key.ne(&Pubkey::default());

    let activation_point = Some(ActivationHandler::get_max_activation_point(
        activation_type,
    )?);

    let customizable_parameters = CustomizableParams {
        activation_point,
        has_alpha_vault,
        activation_type,
        trade_fee_numerator: trade_fee_numerator
            .try_into()
            .map_err(|_| PoolError::TypeCastFailed)?,
        padding: [0; 53],
    };

    // validate
    customizable_parameters.validate(&Clock::get()?)?;

    validate_fee_fraction(protocol_fee_percent.into(), 100)?;
    validate_fee_fraction(partner_fee_percent.into(), 100)?;
    validate_fee_fraction(referral_fee_percent.into(), 100)?;

    let partner_info = PartnerInfo {
        partner_authority: pool_creator_authority,
        fee_percent: partner_fee_percent,
        ..Default::default()
    };

    partner_info.validate()?;

    let pool_fees = PoolFees {
        trade_fee_numerator,
        protocol_fee_percent,
        partner_fee_percent,
        referral_fee_percent,
    };

    let mut config = ctx.accounts.config.load_init()?;
    config.init(
        &pool_fees,
        vault_config_key,
        pool_creator_authority,
        activation_type,
        sqrt_min_price,
        sqrt_max_price,
        collect_fee_mode.into(),
    );

    emit_cpi!(event::EvtCreateConfig {
        trade_fee_numerator,
        protocol_fee_percent,
        config: ctx.accounts.config.key(),
        partner_fee_percent,
        referral_fee_percent,
        vault_config_key,
        pool_creator_authority,
        activation_type,
        index,
    });

    Ok(())
}
