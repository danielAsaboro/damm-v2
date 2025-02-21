use crate::assert_eq_admin;
use crate::constants::{ LIQUIDITY_SCALE, NUM_REWARDS, SCALE_OFFSET };
use crate::curve::get_delta_amount_a_unsigned_unchecked;
use crate::params::swap::TradeDirection;
use crate::utils_math::{ safe_mul_shr_cast, safe_shl_div_cast };
use crate::{
    curve::{
        get_delta_amount_a_unsigned,
        get_delta_amount_b_unsigned,
        get_next_sqrt_price_from_input,
    },
    safe_math::SafeMath,
    u128x128_math::Rounding,
    PoolError,
};
use ruint::aliases::U256;
use std::u64;
use std::cmp::min;

use super::fee::{ DynamicFeeStruct, FeeOnAmountResult, PoolFeesStruct };
use super::Position;
use anchor_lang::prelude::*;
use num_enum::{ IntoPrimitive, TryFromPrimitive };
/// collect fee mode
#[repr(u8)]
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    IntoPrimitive,
    TryFromPrimitive,
    AnchorDeserialize,
    AnchorSerialize
)]
pub enum CollectFeeMode {
    /// Both token, in this mode only out token is collected
    BothToken,
    /// Only token B, we just need token B, because if user want to collect fee in token A, they just need to flip order of tokens
    OnlyB,
}

/// collect fee mode
#[repr(u8)]
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    IntoPrimitive,
    TryFromPrimitive,
    AnchorDeserialize,
    AnchorSerialize
)]
pub enum PoolStatus {
    Enable,
    Disable,
}

#[repr(u8)]
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    IntoPrimitive,
    TryFromPrimitive,
    AnchorDeserialize,
    AnchorSerialize
)]
pub enum PoolType {
    Permissionless,
    Customizable,
}

#[account(zero_copy)]
#[derive(InitSpace, Debug, Default)]
pub struct Pool {
    /// Pool fee
    pub pool_fees: PoolFeesStruct,
    /// token a mint
    pub token_a_mint: Pubkey,
    /// token b mint
    pub token_b_mint: Pubkey,
    /// token a vault
    pub token_a_vault: Pubkey,
    /// token b vault
    pub token_b_vault: Pubkey,
    /// Whitelisted vault to be able to buy pool before activation_point
    pub whitelisted_vault: Pubkey,
    /// partner
    pub partner: Pubkey,
    /// liquidity share
    pub liquidity: u128,
    /// token a reserve
    pub token_a_reserve: u64,
    /// token b reserve
    pub token_b_reserve: u64,
    /// protocol a fee
    pub protocol_a_fee: u64,
    /// protocol b fee
    pub protocol_b_fee: u64,
    /// partner a fee
    pub partner_a_fee: u64,
    /// partner b fee
    pub partner_b_fee: u64,
    /// min price
    pub sqrt_min_price: u128,
    /// max price
    pub sqrt_max_price: u128,
    /// current price
    pub sqrt_price: u128,
    /// Activation point, can be slot or timestamp
    pub activation_point: u64,
    /// Activation type, 0 means by slot, 1 means by timestamp
    pub activation_type: u8,
    /// pool status, 0: enable, 1 disable
    pub pool_status: u8,
    /// token a flag
    pub token_a_flag: u8,
    /// token b flag
    pub token_b_flag: u8,
    /// 0 is collect fee in both token, 1 only collect fee in token a, 2 only collect fee in token b
    pub collect_fee_mode: u8,
    /// pool type
    pub pool_type: u8,
    /// padding
    pub _padding_0: [u8; 2],
    /// cummulative
    pub fee_a_per_liquidity: u128,
    /// cummulative
    pub fee_b_per_liquidity: u128,
    // TODO: Is this large enough?
    pub permanent_lock_liquidity: u128,
    /// metrics
    pub metrics: PoolMetrics,
    /// Farming reward information
    pub reward_infos: [RewardInfo; NUM_REWARDS],
    /// Padding for further use
    pub _padding_1: [u64; 10],
}

#[zero_copy]
#[derive(Debug, InitSpace, Default)]
pub struct PoolMetrics {
    pub total_lp_a_fee: u128,
    pub total_lp_b_fee: u128,
    pub total_protocol_a_fee: u64,
    pub total_protocol_b_fee: u64,
    pub total_partner_a_fee: u64,
    pub total_partner_b_fee: u64,
    pub total_position: u64,
}

impl PoolMetrics {
    pub fn inc_position(&mut self) -> Result<()> {
        self.total_position = self.total_position.safe_add(1)?;
        Ok(())
    }
    pub fn rec_position(&mut self) -> Result<()> {
        self.total_position = self.total_position.safe_sub(1)?;
        Ok(())
    }

    pub fn accumulate_fee(
        &mut self,
        lp_fee: u64,
        protocol_fee: u64,
        partner_fee: u64,
        is_token_a: bool
    ) -> Result<()> {
        if is_token_a {
            self.total_lp_a_fee = self.total_lp_a_fee.safe_add(lp_fee.into())?;
            self.total_protocol_a_fee = self.total_protocol_a_fee.safe_add(protocol_fee)?;
            self.total_partner_a_fee = self.total_partner_a_fee.safe_add(partner_fee)?;
        } else {
            self.total_lp_b_fee = self.total_lp_b_fee.safe_add(lp_fee.into())?;
            self.total_protocol_b_fee = self.total_protocol_b_fee.safe_add(protocol_fee)?;
            self.total_partner_b_fee = self.total_partner_b_fee.safe_add(partner_fee)?;
        }

        Ok(())
    }
}

/// Stores the state relevant for tracking liquidity mining rewards
#[zero_copy]
#[derive(InitSpace, Default, Debug, PartialEq)]
pub struct RewardInfo {
    /// Reward initialize
    pub intialized: u8,
    /// reward token flag
    pub reward_token_flag: u8,
    /// padding
    pub _padding_0: [u8; 6],
    /// Reward token mint.
    pub mint: Pubkey,
    /// Reward vault token account.
    pub vault: Pubkey,
    /// Authority account that allows to fund rewards
    pub funder: Pubkey,
    /// reward duration
    pub reward_duration: u64, // 8
    /// reward duration end
    pub reward_duration_end: u64, // 8
    /// reward rate
    pub reward_rate: u128, // 8
    /// reward_a_per_token_stored
    pub reward_per_token_stored: u128,
    /// The last time reward states were updated.
    pub last_update_time: u64, // 8
    /// Accumulated seconds where when farm distribute rewards, but the bin is empty. The reward will be accumulated for next reward time window.
    pub cumulative_seconds_with_empty_liquidity_reward: u64,
}

impl RewardInfo {
    /// Returns true if this reward is initialized.
    /// Once initialized, a reward cannot transition back to uninitialized.
    pub fn initialized(&self) -> bool {
        self.intialized != 0
    }

    pub fn is_valid_funder(&self, funder: Pubkey) -> bool {
        assert_eq_admin(funder) || funder.eq(&self.funder)
    }

    pub fn init_reward(
        &mut self,
        mint: Pubkey,
        vault: Pubkey,
        funder: Pubkey,
        reward_duration: u64,
        reward_token_flag: u8
    ) {
        self.intialized = 1;
        self.mint = mint;
        self.vault = vault;
        self.funder = funder;
        self.reward_duration = reward_duration;
        self.reward_token_flag = reward_token_flag;
    }

    pub fn update_rewards(&mut self, liquidity_supply: u64, current_time: u64) -> Result<()> {
        // Update reward if it initialized
        if self.initialized() {
            if liquidity_supply > 0 {
                let reward_per_token_stored_delta =
                    self.calculate_reward_per_token_stored_since_last_update(
                        current_time,
                        liquidity_supply
                    )?;

                self.accumulate_reward_per_token_stored(reward_per_token_stored_delta)?;
            } else {
                // Time period which the reward was distributed to empty
                let time_period = self.get_seconds_elapsed_since_last_update(current_time)?;

                // Save the time window of empty reward, and reward it in the next time window
                self.cumulative_seconds_with_empty_liquidity_reward =
                    self.cumulative_seconds_with_empty_liquidity_reward.safe_add(time_period)?;
            }

            self.update_last_update_time(current_time);
        }

        Ok(())
    }

    pub fn update_last_update_time(&mut self, current_time: u64) {
        self.last_update_time = min(current_time, self.reward_duration_end);
    }

    pub fn get_seconds_elapsed_since_last_update(&self, current_time: u64) -> Result<u64> {
        let last_time_reward_applicable = min(current_time, self.reward_duration_end);
        let time_period = last_time_reward_applicable.safe_sub(self.last_update_time.into())?;

        Ok(time_period)
    }

    // To make it simple we truncate decimals of liquidity_supply for the calculation
    pub fn calculate_reward_per_token_stored_since_last_update(
        &self,
        current_time: u64,
        liquidity_supply: u64
    ) -> Result<u128> {
        let time_period: u128 = self.get_seconds_elapsed_since_last_update(current_time)?.into();
        let total_reward = time_period.safe_mul(self.reward_rate.into())?;

        safe_shl_div_cast(total_reward, liquidity_supply.into(), SCALE_OFFSET, Rounding::Down)
    }

    pub fn accumulate_reward_per_token_stored(&mut self, delta: u128) -> Result<()> {
        self.reward_per_token_stored = self.reward_per_token_stored.safe_add(delta)?;
        Ok(())
    }

    /// Farming rate after funding
    pub fn update_rate_after_funding(
        &mut self,
        current_time: u64,
        funding_amount: u64
    ) -> Result<()> {
        let reward_duration_end = self.reward_duration_end;

        let total_amount = if current_time >= reward_duration_end {
            funding_amount
        } else {
            let remaining_seconds = reward_duration_end.safe_sub(current_time)?;
            let leftover: u64 = safe_mul_shr_cast(
                self.reward_rate,
                remaining_seconds.into(),
                SCALE_OFFSET
            )?;

            leftover.safe_add(funding_amount)?;

            leftover
        };

        self.reward_rate = safe_shl_div_cast(
            total_amount.into(),
            self.reward_duration.into(),
            SCALE_OFFSET,
            Rounding::Down
        )?;
        self.last_update_time = current_time;
        self.reward_duration_end = current_time.safe_add(self.reward_duration)?;

        Ok(())
    }
}

impl Pool {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        pool_fees: PoolFeesStruct,
        token_a_mint: Pubkey,
        token_b_mint: Pubkey,
        token_a_vault: Pubkey,
        token_b_vault: Pubkey,
        whitelisted_vault: Pubkey,
        partner: Pubkey,
        sqrt_min_price: u128,
        sqrt_max_price: u128,
        sqrt_price: u128,
        activation_point: u64,
        activation_type: u8,
        token_a_flag: u8,
        token_b_flag: u8,
        token_a_reserve: u64,
        token_b_reserve: u64,
        liquidity: u128,
        collect_fee_mode: u8,
        pool_type: u8
    ) {
        self.pool_fees = pool_fees;
        self.token_a_mint = token_a_mint;
        self.token_b_mint = token_b_mint;
        self.token_a_vault = token_a_vault;
        self.token_b_vault = token_b_vault;
        self.whitelisted_vault = whitelisted_vault;
        self.partner = partner;
        self.sqrt_min_price = sqrt_min_price;
        self.sqrt_max_price = sqrt_max_price;
        self.activation_point = activation_point;
        self.activation_type = activation_type;
        self.token_a_flag = token_a_flag;
        self.token_b_flag = token_b_flag;
        self.token_a_reserve = token_a_reserve;
        self.token_b_reserve = token_b_reserve;
        self.liquidity = liquidity;
        self.sqrt_price = sqrt_price;
        self.collect_fee_mode = collect_fee_mode;
        self.pool_type = pool_type;
    }

    pub fn pool_reward_initialized(&self) -> bool {
        self.reward_infos[0].initialized() || self.reward_infos[1].initialized()
    }

    pub fn get_swap_result(
        &self,
        amount_in: u64,
        is_referral: bool,
        trade_direction: TradeDirection
    ) -> Result<SwapResult> {
        let collect_fee_mode = CollectFeeMode::try_from(self.collect_fee_mode).map_err(
            |_| PoolError::InvalidCollectFeeMode
        )?;

        match collect_fee_mode {
            CollectFeeMode::BothToken =>
                match trade_direction {
                    TradeDirection::AtoB =>
                        self.get_swap_result_from_a_to_b(amount_in, is_referral),
                    TradeDirection::BtoA => {
                        self.get_swap_result_from_b_to_a(amount_in, is_referral, false)
                    }
                }
            CollectFeeMode::OnlyB =>
                match trade_direction {
                    TradeDirection::AtoB =>
                        self.get_swap_result_from_a_to_b(amount_in, is_referral), // this is fine since we still collect fee in token out
                    TradeDirection::BtoA => {
                        // fee will be in token b
                        let FeeOnAmountResult {
                            amount,
                            lp_fee,
                            protocol_fee,
                            partner_fee,
                            referral_fee,
                        } = self.pool_fees.get_fee_on_amount(amount_in, is_referral)?;
                        // skip fee
                        let swap_result = self.get_swap_result_from_b_to_a(
                            amount,
                            is_referral,
                            true
                        )?;

                        Ok(SwapResult {
                            output_amount: swap_result.output_amount,
                            next_sqrt_price: swap_result.next_sqrt_price,
                            lp_fee,
                            protocol_fee,
                            partner_fee,
                            referral_fee,
                        })
                    }
                }
        }
    }
    fn get_swap_result_from_a_to_b(&self, amount_in: u64, is_referral: bool) -> Result<SwapResult> {
        // finding new target price
        let next_sqrt_price = get_next_sqrt_price_from_input(
            self.sqrt_price,
            self.liquidity,
            amount_in,
            true
        )?;

        if next_sqrt_price < self.sqrt_min_price {
            return Err(PoolError::PriceRangeViolation.into());
        }

        // finding output amount
        let output_amount = get_delta_amount_b_unsigned(
            next_sqrt_price,
            self.sqrt_price,
            self.liquidity,
            Rounding::Down
        )?;

        let FeeOnAmountResult { amount, lp_fee, protocol_fee, partner_fee, referral_fee } =
            self.pool_fees.get_fee_on_amount(output_amount, is_referral)?;
        Ok(SwapResult {
            output_amount: amount,
            lp_fee,
            protocol_fee,
            partner_fee,
            referral_fee,
            next_sqrt_price,
        })
    }

    fn get_swap_result_from_b_to_a(
        &self,
        amount_in: u64,
        is_referral: bool,
        is_skip_fee: bool
    ) -> Result<SwapResult> {
        // finding new target price
        let next_sqrt_price = get_next_sqrt_price_from_input(
            self.sqrt_price,
            self.liquidity,
            amount_in,
            false
        )?;

        if next_sqrt_price > self.sqrt_max_price {
            return Err(PoolError::PriceRangeViolation.into());
        }
        // finding output amount
        let output_amount = get_delta_amount_a_unsigned(
            self.sqrt_price,
            next_sqrt_price,
            self.liquidity,
            Rounding::Down
        )?;

        if is_skip_fee {
            Ok(SwapResult {
                output_amount,
                lp_fee: 0,
                protocol_fee: 0,
                partner_fee: 0,
                referral_fee: 0,
                next_sqrt_price,
            })
        } else {
            let FeeOnAmountResult { amount, lp_fee, protocol_fee, partner_fee, referral_fee } =
                self.pool_fees.get_fee_on_amount(output_amount, is_referral)?;
            Ok(SwapResult {
                output_amount: amount,
                lp_fee,
                protocol_fee,
                partner_fee,
                referral_fee,
                next_sqrt_price,
            })
        }
    }

    pub fn apply_swap_result(
        &mut self,
        swap_result: &SwapResult,
        trade_direction: TradeDirection,
        current_timestamp: u64
    ) -> Result<()> {
        let &SwapResult {
            output_amount: _output_amount,
            lp_fee,
            next_sqrt_price,
            protocol_fee,
            partner_fee,
            referral_fee: _referral_fee,
        } = swap_result;

        let old_sqrt_price = self.sqrt_price;
        self.sqrt_price = next_sqrt_price;
        let fee_per_token_stored: u128 = safe_shl_div_cast(
            lp_fee.into(),
            self.liquidity,
            LIQUIDITY_SCALE,
            Rounding::Down
        )?;

        let collect_fee_mode = CollectFeeMode::try_from(self.collect_fee_mode).map_err(
            |_| PoolError::InvalidCollectFeeMode
        )?;

        if collect_fee_mode == CollectFeeMode::OnlyB || trade_direction == TradeDirection::AtoB {
            self.partner_b_fee = self.partner_b_fee.safe_add(partner_fee)?;
            self.protocol_b_fee = self.partner_b_fee.safe_add(protocol_fee)?;
            self.fee_b_per_liquidity = self.fee_b_per_liquidity.safe_add(fee_per_token_stored)?;
            self.metrics.accumulate_fee(lp_fee, protocol_fee, partner_fee, false)?;
        } else {
            self.partner_a_fee = self.partner_a_fee.safe_add(partner_fee)?;
            self.protocol_a_fee = self.partner_a_fee.safe_add(protocol_fee)?;
            self.fee_a_per_liquidity = self.fee_a_per_liquidity.safe_add(fee_per_token_stored)?;
            self.metrics.accumulate_fee(lp_fee, protocol_fee, partner_fee, true)?;
        }
        self.update_post_swap(old_sqrt_price, current_timestamp)?;
        Ok(())
    }

    pub fn get_amounts_for_modify_liquidity(
        &self,
        liquidity_delta: u128,
        round: Rounding
    ) -> Result<ModifyLiquidityResult> {
        // finding output amount
        let amount_a = get_delta_amount_a_unsigned(
            self.sqrt_price,
            self.sqrt_max_price,
            liquidity_delta,
            round
        )?;

        let amount_b = get_delta_amount_b_unsigned(
            self.sqrt_min_price,
            self.sqrt_price,
            liquidity_delta,
            round
        )?;

        Ok(ModifyLiquidityResult { amount_a, amount_b })
    }

    pub fn apply_add_liquidity(
        &mut self,
        position: &mut Position,
        liquidity_delta: u128
    ) -> Result<()> {
        // update current fee for position
        position.update_fee(self.fee_a_per_liquidity, self.fee_b_per_liquidity)?;

        // add liquidity
        position.add_liquidity(liquidity_delta)?;

        self.liquidity = self.liquidity.safe_add(liquidity_delta)?;

        Ok(())
    }

    pub fn apply_remove_liquidity(
        &mut self,
        position: &mut Position,
        liquidity_delta: u128
    ) -> Result<()> {
        // update current fee for position
        position.update_fee(self.fee_a_per_liquidity, self.fee_b_per_liquidity)?;

        // remove liquidity
        position.remove_unlocked_liquidity(liquidity_delta)?;

        self.liquidity = self.liquidity.safe_sub(liquidity_delta)?;

        Ok(())
    }

    pub fn get_max_amount_in(&self, trade_direction: TradeDirection) -> Result<u64> {
        let amount = match trade_direction {
            TradeDirection::AtoB =>
                get_delta_amount_a_unsigned_unchecked(
                    self.sqrt_min_price,
                    self.sqrt_price,
                    self.liquidity,
                    Rounding::Down
                )?,
            TradeDirection::BtoA =>
                get_delta_amount_a_unsigned_unchecked(
                    self.sqrt_price,
                    self.sqrt_max_price,
                    self.liquidity,
                    Rounding::Down
                )?,
        };
        if amount > U256::from(u64::MAX) {
            Ok(u64::MAX)
        } else {
            Ok(amount.try_into().unwrap())
        }
    }

    pub fn update_pre_swap(&mut self, current_timestamp: u64) -> Result<()> {
        if self.pool_fees.dynamic_fee.is_dynamic_fee_enable() {
            self.pool_fees.dynamic_fee.update_references(self.sqrt_price, current_timestamp)?;
        }
        Ok(())
    }

    pub fn update_post_swap(&mut self, old_sqrt_price: u128, current_timestamp: u64) -> Result<()> {
        if self.pool_fees.dynamic_fee.is_dynamic_fee_enable() {
            self.pool_fees.dynamic_fee.update_volatility_accumulator(self.sqrt_price)?;

            // update only last_update_timestamp if bin is crossed
            let delta_price = DynamicFeeStruct::get_detal_bin_id(
                self.pool_fees.dynamic_fee.bin_step_u128,
                old_sqrt_price,
                self.sqrt_price
            )?;
            if delta_price > 0 {
                self.pool_fees.dynamic_fee.last_update_timestamp = current_timestamp;
            }
        }
        Ok(())
    }

    pub fn accumulate_permanent_locked_liquidity(
        &mut self,
        permanent_locked_liquidity: u128
    ) -> Result<()> {
        self.permanent_lock_liquidity = self.permanent_lock_liquidity.safe_add(
            permanent_locked_liquidity
        )?;

        Ok(())
    }

    pub fn claim_protocol_fee(&mut self) -> (u64, u64) {
        let token_a_amount = self.protocol_a_fee;
        let token_b_amount = self.protocol_b_fee;
        self.protocol_a_fee = 0;
        self.protocol_b_fee = 0;
        (token_a_amount, token_b_amount)
    }

    pub fn claim_partner_fee(
        &mut self,
        max_amount_a: u64,
        max_amount_b: u64
    ) -> Result<(u64, u64)> {
        let token_a_amount = self.partner_a_fee.min(max_amount_a);
        let token_b_amount = self.partner_b_fee.min(max_amount_b);
        self.partner_a_fee = self.partner_a_fee.safe_sub(token_a_amount)?;
        self.partner_b_fee = self.partner_b_fee.safe_sub(token_b_amount)?;
        Ok((token_a_amount, token_b_amount))
    }

    /// Update the rewards per token stored.
    pub fn update_rewards(&mut self, current_time: u64) -> Result<()> {
        for reward_idx in 0..NUM_REWARDS {
            let reward_info = &mut self.reward_infos[reward_idx];
            reward_info.update_rewards(self.liquidity as u64, current_time)?;
        }

        Ok(())
    }

    pub fn claim_ineligible_reward(&mut self, reward_index: usize) -> Result<u64> {
        // calculate ineligible reward
        let reward_info = &mut self.reward_infos[reward_index];
        let (ineligible_reward, _) = U256::from(
            reward_info.cumulative_seconds_with_empty_liquidity_reward
        )
            .safe_mul(U256::from(reward_info.reward_rate))?
            .overflowing_shr(SCALE_OFFSET.into());

        reward_info.cumulative_seconds_with_empty_liquidity_reward = 0;

        let ineligible_reward: u64 = ineligible_reward
            .try_into()
            .map_err(|_| PoolError::TypeCastFailed)?;

        Ok(ineligible_reward)
    }
}

/// Encodes all results of swapping
#[derive(Debug, PartialEq, AnchorDeserialize, AnchorSerialize)]
pub struct SwapResult {
    pub output_amount: u64,
    pub next_sqrt_price: u128,
    pub lp_fee: u64,
    pub protocol_fee: u64,
    pub partner_fee: u64,
    pub referral_fee: u64,
}

#[derive(Debug, PartialEq)]
pub struct ModifyLiquidityResult {
    pub amount_a: u64,
    pub amount_b: u64,
}
