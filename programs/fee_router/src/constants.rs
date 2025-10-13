// Constants module - no imports needed for constants

// PDA Seeds
pub const VAULT_SEED: &[u8] = b"vault";
pub const INVESTOR_FEE_POS_OWNER_SEED: &[u8] = b"investor_fee_pos_owner";
pub const POLICY_SEED: &[u8] = b"policy";
pub const PROGRESS_SEED: &[u8] = b"progress";
pub const TREASURY_SEED: &[u8] = b"treasury";

// Time constants
pub const SECONDS_PER_DAY: i64 = 86400;

// Math constants
pub const BASIS_POINTS_DIVISOR: u64 = 10000;
pub const PRECISION_MULTIPLIER: u64 = 1_000_000; // For precise calculations

// Limits
pub const MAX_PAGE_SIZE: u32 = 50; // Prevent excessive compute usage
pub const MIN_PAYOUT_THRESHOLD: u64 = 1000; // Minimum lamports to distribute
pub const MAX_DAILY_CAP: u64 = u64::MAX; // No cap by default

// Error codes for debugging
pub const ERR_QUOTE_VALIDATION_FAILED: u32 = 6000;
pub const ERR_BASE_FEES_DETECTED: u32 = 6001;
pub const ERR_CRANK_WINDOW_NOT_REACHED: u32 = 6002;
pub const ERR_INVALID_PAGINATION: u32 = 6003;