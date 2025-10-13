/// CP-AMM types matching the real DAMM v2 implementation
/// Based on resources/damm-v2/programs/cp-amm/src/state/
use anchor_lang::prelude::*;

// Pool struct matching the exact structure from DAMM v2
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
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
    /// padding, previous reserve amount, be careful to use that field
    pub _padding: u128,
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
    /// Additional padding to match exact struct size
    pub additional_padding: [u8; 26],
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            pool_fees: PoolFeesStruct::default(),
            token_a_mint: Pubkey::default(),
            token_b_mint: Pubkey::default(),
            token_a_vault: Pubkey::default(),
            token_b_vault: Pubkey::default(),
            whitelisted_vault: Pubkey::default(),
            partner: Pubkey::default(),
            liquidity: 0,
            _padding: 0,
            protocol_a_fee: 0,
            protocol_b_fee: 0,
            partner_a_fee: 0,
            partner_b_fee: 0,
            sqrt_min_price: 0,
            sqrt_max_price: 0,
            sqrt_price: 0,
            activation_point: 0,
            activation_type: 0,
            pool_status: 0,
            token_a_flag: 0,
            token_b_flag: 0,
            collect_fee_mode: 0,
            pool_type: 0,
            additional_padding: [0; 26],
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct PoolFeesStruct {
    // We don't actually use the pool fees struct details in our validation
    // Just need it to exist for the account deserialization
    pub _padding: [u8; 32],
}

impl Default for PoolFeesStruct {
    fn default() -> Self {
        Self {
            _padding: [0; 32],
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Position {
    pub pool: Pubkey,
    /// nft mint
    pub nft_mint: Pubkey,
    /// fee a checkpoint
    pub fee_a_per_token_checkpoint: [u8; 32], // U256
    /// fee b checkpoint
    pub fee_b_per_token_checkpoint: [u8; 32], // U256
    /// fee a pending
    pub fee_a_pending: u64,
    /// fee b pending
    pub fee_b_pending: u64,
    /// unlock liquidity
    pub unlocked_liquidity: u128,
    /// vesting liquidity
    pub vested_liquidity: u128,
    /// permanent locked liquidity
    pub permanent_locked_liquidity: u128,
    /// metrics
    pub metrics: PositionMetrics,
    /// Farming reward information (simplified - NUM_REWARDS = 2)
    pub reward_infos: [UserRewardInfo; 2],
    /// padding for future usage
    pub padding: [u128; 6],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct PositionMetrics {
    pub total_claimed_a_fee: u64,
    pub total_claimed_b_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct UserRewardInfo {
    /// The latest update reward checkpoint
    pub reward_per_token_checkpoint: [u8; 32], // U256
    /// Current pending rewards
    pub reward_pendings: u64,
    /// Total claimed rewards
    pub total_claimed_rewards: u64,
}

impl Default for Position {
    fn default() -> Self {
        Self {
            pool: Pubkey::default(),
            nft_mint: Pubkey::default(),
            fee_a_per_token_checkpoint: [0; 32],
            fee_b_per_token_checkpoint: [0; 32],
            fee_a_pending: 0,
            fee_b_pending: 0,
            unlocked_liquidity: 0,
            vested_liquidity: 0,
            permanent_locked_liquidity: 0,
            metrics: PositionMetrics::default(),
            reward_infos: [UserRewardInfo::default(); 2],
            padding: [0; 6],
        }
    }
}

// For CPI, we'll create our own account structs that match CP-AMM's interface
// but don't require importing the full program

#[derive(Accounts)]
pub struct CreatePositionAccounts<'info> {
    /// CHECK: Owner of the position
    pub owner: AccountInfo<'info>,
    /// CHECK: The position NFT mint
    pub position_nft_mint: AccountInfo<'info>,
    /// CHECK: The position NFT token account
    pub position_nft_account: AccountInfo<'info>,
    /// CHECK: The pool account
    pub pool: AccountInfo<'info>,
    /// CHECK: The position account
    pub position: AccountInfo<'info>,
    /// CHECK: Pool authority
    pub pool_authority: AccountInfo<'info>,
    /// CHECK: Payer account
    pub payer: AccountInfo<'info>,
    /// CHECK: Token program
    pub token_program: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClaimPositionFeeAccounts<'info> {
    /// CHECK: Pool authority
    pub pool_authority: AccountInfo<'info>,
    /// CHECK: The pool account
    pub pool: AccountInfo<'info>,
    /// CHECK: The position account
    pub position: AccountInfo<'info>,
    /// CHECK: Token A account
    pub token_a_account: AccountInfo<'info>,
    /// CHECK: Token B account  
    pub token_b_account: AccountInfo<'info>,
    /// CHECK: Token A vault
    pub token_a_vault: AccountInfo<'info>,
    /// CHECK: Token B vault
    pub token_b_vault: AccountInfo<'info>,
    /// CHECK: Token A mint
    pub token_a_mint: AccountInfo<'info>,
    /// CHECK: Token B mint
    pub token_b_mint: AccountInfo<'info>,
    /// CHECK: Position NFT account
    pub position_nft_account: AccountInfo<'info>,
    /// CHECK: Owner account
    pub owner: AccountInfo<'info>,
    /// CHECK: Token A program
    pub token_a_program: AccountInfo<'info>,
    /// CHECK: Token B program
    pub token_b_program: AccountInfo<'info>,
}

// CP-AMM Program ID
declare_id!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

/// Program struct for CPI
pub struct CpAmm;

impl anchor_lang::Id for CpAmm {
    fn id() -> Pubkey {
        ID
    }
}

// Manual Owner implementations for custom program ID
impl anchor_lang::Owner for Pool {
    fn owner() -> Pubkey {
        ID
    }
}

impl anchor_lang::Owner for Position {
    fn owner() -> Pubkey {
        ID
    }
}

impl anchor_lang::AccountSerialize for Pool {
    fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
        AnchorSerialize::serialize(self, writer).map_err(Into::into)
    }
}

impl anchor_lang::AccountSerialize for Position {
    fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
        AnchorSerialize::serialize(self, writer).map_err(Into::into)
    }
}

impl anchor_lang::AccountDeserialize for Pool {
    fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        if buf.len() < 8 {
            return Err(ErrorCode::AccountDidNotDeserialize.into());
        }
        let mut data: &[u8] = &buf[8..];
        Pool::deserialize(&mut data).map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        let mut data: &[u8] = &buf[8..];
        Pool::deserialize(&mut data).map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
    }
}

impl anchor_lang::AccountDeserialize for Position {
    fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        if buf.len() < 8 {
            return Err(ErrorCode::AccountDidNotDeserialize.into());
        }
        let mut data: &[u8] = &buf[8..];
        Position::deserialize(&mut data).map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        let mut data: &[u8] = &buf[8..];
        Position::deserialize(&mut data).map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
    }
}

// Add Discriminator trait implementations
impl anchor_lang::Discriminator for Pool {
    const DISCRIMINATOR: &'static [u8] = &[241, 154, 109, 4, 17, 177, 109, 188];
}

impl anchor_lang::Discriminator for Position {
    const DISCRIMINATOR: &'static [u8] = &[170, 188, 143, 228, 122, 64, 247, 208];
}