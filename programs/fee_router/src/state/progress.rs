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

    /// Persistent dust carried from previous day (added to next day's claimable pool)
    pub persistent_carry_over: u64,

    /// Bitmap tracking which investors have been paid today
    /// Each bit represents one investor (bit 0 = investor 0, bit 1 = investor 1, etc.)
    /// Supports up to 2048 investors (256 bytes * 8 bits)
    pub paid_investor_bitmap: [u8; 256],
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

        // Add persistent carry-over (dust from previous day) to today's claimable pool
        // This ensures dust gets redistributed instead of being lost
        self.current_day_total_claimed = total_claimed.saturating_add(self.persistent_carry_over);
        self.current_day_total_locked_all = total_locked_all;

        // Reset persistent carry-over now that it's been added to the pool
        self.persistent_carry_over = 0;

        // Reset bitmap for new day
        self.paid_investor_bitmap = [0u8; 256];
    }
    
    /// Complete current day
    pub fn complete_day(&mut self, creator_amount: u64) {
        self.day_completed = true;
        self.total_distributions += 1;
        self.total_creator_distributed += creator_amount;
        self.pagination_cursor = 0;

        // Persist current day's dust to carry forward to next day
        self.persistent_carry_over = self.current_day_carry_over;

        // Reset bitmap for next day
        self.paid_investor_bitmap = [0u8; 256];
    }

    /// Check if an investor has already been paid today
    pub fn is_investor_paid(&self, investor_index: u32) -> bool {
        let byte_idx = (investor_index / 8) as usize;
        let bit_idx = (investor_index % 8) as u8;

        if byte_idx >= self.paid_investor_bitmap.len() {
            return false; // Out of bounds, treat as not paid
        }

        (self.paid_investor_bitmap[byte_idx] & (1 << bit_idx)) != 0
    }

    /// Mark an investor as paid
    pub fn mark_investor_paid(&mut self, investor_index: u32) -> Result<()> {
        let byte_idx = (investor_index / 8) as usize;
        let bit_idx = (investor_index % 8) as u8;

        require!(
            byte_idx < self.paid_investor_bitmap.len(),
            crate::error::HonouraryError::InvalidPagination
        );

        self.paid_investor_bitmap[byte_idx] |= 1 << bit_idx;
        Ok(())
    }

    /// Reset bitmap (called when starting new day)
    pub fn reset_bitmap(&mut self) {
        self.paid_investor_bitmap = [0u8; 256];
    }
}