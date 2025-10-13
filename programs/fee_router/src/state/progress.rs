use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct DistributionProgress {
    /// The vault this progress tracking applies to
    pub vault: Pubkey,
    
    /// Timestamp of last distribution start
    pub last_distribution_ts: i64,
    
    /// Amount distributed in current day (lamports)
    pub current_day_distributed: u64,
    
    /// Carry-over dust from previous pages/days
    pub current_day_carry_over: u64,
    
    /// Current pagination cursor (investor index)
    pub pagination_cursor: u32,
    
    /// Whether current day distribution is completed
    pub day_completed: bool,
    
    /// Current day total claimed fees
    pub current_day_total_claimed: u64,
    
    /// PDA bump seed
    pub bump: u8,
    
    /// Total distributions completed
    pub total_distributions: u64,
    
    /// Total lifetime distributed to investors
    pub total_investor_distributed: u64,
    
    /// Total lifetime distributed to creator
    pub total_creator_distributed: u64,

    /// Total locked amount across ALL investors for current day (calculated once on first page)
    pub current_day_total_locked_all: u64,
}

impl DistributionProgress {
    pub const SEEDS_PREFIX: &'static [u8] = crate::constants::PROGRESS_SEED;
    
    pub fn seeds<'a>(&'a self) -> [&'a [u8]; 3] {
        [
            Self::SEEDS_PREFIX,
            self.vault.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }
    
    /// Check if enough time has passed for next distribution
    pub fn can_distribute(&self, current_timestamp: i64) -> bool {
        if self.day_completed {
            current_timestamp >= self.last_distribution_ts + crate::constants::SECONDS_PER_DAY
        } else {
            // Can continue same day distribution
            true
        }
    }
    
    /// Reset for new day
    pub fn start_new_day(&mut self, current_timestamp: i64, total_claimed: u64, total_locked_all: u64) {
        self.last_distribution_ts = current_timestamp;
        self.current_day_distributed = 0;
        self.current_day_carry_over = 0;
        self.pagination_cursor = 0;
        self.day_completed = false;
        self.current_day_total_claimed = total_claimed;
        self.current_day_total_locked_all = total_locked_all;
    }
    
    /// Complete current day
    pub fn complete_day(&mut self, creator_amount: u64) {
        self.day_completed = true;
        self.total_distributions += 1;
        self.total_creator_distributed += creator_amount;
        self.pagination_cursor = 0;
    }
}