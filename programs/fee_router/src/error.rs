use anchor_lang::prelude::*;

#[error_code]
pub enum HonouraryError {
    #[msg("Quote-only validation failed: pool configuration allows base token fees")]
    QuoteOnlyValidationFailed = 6000,

    #[msg("Base token fees detected during fee claiming - distribution aborted")]
    BaseFeesDetected = 6001,

    #[msg("24-hour crank window not reached - distribution too early")]
    CrankWindowNotReached = 6002,

    #[msg("Invalid pagination parameters - check page start and size")]
    InvalidPagination = 6003,

    #[msg("Insufficient Streamflow data - cannot read locked amounts")]
    InsufficientStreamflowData = 6004,

    #[msg("Distribution already completed for this day")]
    DistributionAlreadyComplete = 6005,

    #[msg("Invalid pool configuration - not compatible with quote-only requirements")]
    InvalidPoolConfiguration = 6006,

    #[msg("Math overflow in distribution calculations")]
    MathOverflow = 6007,

    #[msg("Investor ATA count mismatch with Streamflow accounts")]
    AccountCountMismatch = 6008,

    #[msg("Daily distribution cap exceeded")]
    DailyCapExceeded = 6009,

    #[msg("Position not owned by program PDA")]
    InvalidPositionOwnership = 6010,

    #[msg("Page already processed - cannot replay pages during active distribution")]
    PageAlreadyProcessed = 6011,
}