# Fee Router (Honorary Quote-Only Fee Position)

The Fee Router program creates and manages the honorary DAMM v2 LP position owned by a program PDA that accrues fees **exclusively in the quote mint**. It provides a permissionless 24-hour distribution crank that claims quote fees and distributes them pro-rata to investors based on still-locked amounts in Streamflow vesting contracts.

**Program ID**: `5CGBLxEdT83SQkxg7h2norEjck3BSuK9JY3EDKRCw8Zd`

## Overview

This module enables:

- **Quote-only fee accrual**: Honorary position collects fees only in the quote token (not base token)
- **Program ownership**: Fee position owned by a PDA, not a user wallet
- **Pro-rata distribution**: Fees distributed to investors proportional to their locked token amounts
- **24-hour crank system**: Permissionless cranking with daily caps and pagination support
- **Streamflow integration**: Reads locked amounts directly from Streamflow vesting contracts

## Quick Start

### Prerequisites

```bash
# Install Anchor
anchor --version  # Should be 0.31.1

# Install pnpm (this project uses pnpm)
npm install -g pnpm
```

### Build

```bash
# Build the program
anchor build

# Run tests
anchor test
```

### Integration

```typescript
import { Program } from "@coral-xyz/anchor";
import { Honourary } from "./target/types/honourary";

const program = anchor.workspace.honourary as Program<Honourary>;

// 1. Setup policy (one-time)
await program.methods
  .setupPolicy({
    creatorWallet: creatorPubkey,
    investorFeeShareBps: 3000,  // 30% to investors, 70% to creator
    dailyCapLamports: new BN(1000000),
    minPayoutLamports: new BN(1000),
    y0TotalAllocation: new BN(100000000)  // Total tokens at TGE
  })
  .accounts({...})
  .rpc();

// 2. Initialize honorary position (one-time)
await program.methods
  .initializeHonoraryPosition()
  .accounts({...})
  .rpc();

// 3. Crank distribution (permissionless, once per 24h)
await program.methods
  .crankDistribution(0, 50)  // page_start, page_size
  .accounts({...})
  .remainingAccounts([
    // Streamflow contract accounts for each investor
    { pubkey: streamflowContract1, isSigner: false, isWritable: false },
    // Investor quote ATAs
    { pubkey: investor1QuoteAta, isSigner: false, isWritable: true },
    // ... repeat for all investors
  ])
  .rpc();
```

## Instructions

### 1. `setup_policy`

Configure distribution parameters for a vault. Must be called once before initializing the position.

**Parameters:**

```rust
pub struct PolicyParams {
    pub creator_wallet: Pubkey,       // Receives remainder fees
    pub investor_fee_share_bps: u16,  // 0-10000 (e.g., 3000 = 30%)
    pub daily_cap_lamports: Option<u64>, // Optional daily distribution cap
    pub min_payout_lamports: u64,     // Minimum payout threshold (≥1000)
    pub y0_total_allocation: u64,     // Total investor tokens at TGE
}
```

**Accounts:**

| Account          | Type                            | Mutable | Signer | Description                    |
| ---------------- | ------------------------------- | ------- | ------ | ------------------------------ |
| `authority`      | `Signer`                        | No      | Yes    | Policy creator (can be anyone) |
| `payer`          | `Signer`                        | Yes     | Yes    | Pays for account creation      |
| `vault`          | `UncheckedAccount`              | No      | No     | Vault identifier (seed only)   |
| `policy`         | `Account<Policy>`               | Yes     | No     | Policy PDA (created)           |
| `progress`       | `Account<DistributionProgress>` | Yes     | No     | Progress PDA (created)         |
| `system_program` | `Program`                       | No      | No     | System program                 |

**PDA Seeds:**

- Policy: `["policy", vault.key()]`
- Progress: `["progress", vault.key()]`

**Validation:**

- `investor_fee_share_bps` must be ≤ 10000
- `min_payout_lamports` must be ≥ 1000 (MIN_PAYOUT_THRESHOLD)
- Can only be called once per vault (account init)

**Events Emitted:**

- `PolicySetup`

---

### 2. `initialize_honorary_position`

Creates an honorary DAMM v2 position owned by the program PDA that accrues only quote token fees.

**Parameters:** None

**Accounts:**

| Account                    | Type                                | Mutable | Signer | Description                          |
| -------------------------- | ----------------------------------- | ------- | ------ | ------------------------------------ |
| `payer`                    | `Signer`                            | Yes     | Yes    | Pays for account creation            |
| `vault`                    | `UncheckedAccount`                  | No      | No     | Vault identifier (seed)              |
| `position_owner_pda`       | `Account<InvestorFeePositionOwner>` | Yes     | No     | Position owner PDA (created)         |
| `pool`                     | `Account<Pool>`                     | No      | No     | CP-AMM pool account                  |
| `quote_mint`               | `InterfaceAccount<Mint>`            | No      | No     | Quote token mint                     |
| `base_mint`                | `InterfaceAccount<Mint>`            | No      | No     | Base token mint                      |
| `position_nft_mint`        | `InterfaceAccount<Mint>`            | Yes     | Yes    | Position NFT mint (created)          |
| `position_nft_account`     | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Position NFT token account (created) |
| `position`                 | `UncheckedAccount`                  | Yes     | No     | Position account (created by CP-AMM) |
| `pool_authority`           | `UncheckedAccount`                  | No      | No     | CP-AMM pool authority PDA            |
| `cp_amm_program`           | `Program`                           | No      | No     | CP-AMM program                       |
| `token_program`            | `Interface`                         | No      | No     | Token program (Token or Token-2022)  |
| `associated_token_program` | `Program`                           | No      | No     | Associated token program             |
| `system_program`           | `Program`                           | No      | No     | System program                       |

**PDA Seeds:**

- Position Owner: `["vault", vault.key(), "investor_fee_pos_owner"]`

**Quote-Only Validation:**

- Validates pool token order to identify quote mint
- Creates position configured for quote-only fee accrual
- If quote-only cannot be guaranteed, instruction fails with `QuoteOnlyValidationFailed`

**Events Emitted:**

- `HonoraryPositionInitialized`

---

### 3. `crank_distribution`

Claims fees from the honorary position and distributes them to investors pro-rata based on locked amounts, with remainder to creator. Permissionless, can be called once per 24-hour window with pagination support.

**Parameters:**

```rust
pub fn crank_distribution(
    page_start: u32,  // Starting investor index (0-based)
    page_size: u32,   // Number of investors to process (max 50)
    total_locked_all_investors: u64, // Total locked across ALL investors (calculated off-chain)
)
```

**IMPORTANT: `total_locked_all_investors` Parameter**

This parameter must be calculated off-chain by the caller before calling `crank_distribution`:

1. **Why it's needed**: For multi-page distributions, pro-rata calculations must use the SAME denominator across all pages
2. **How to calculate**: Sum locked amounts from ALL investor Streamflow accounts (not just current page)
3. **When to pass**: On first page (page_start = 0), value is stored in `progress.current_day_total_locked_all`
4. **Subsequent pages**: Can pass any value; stored value from first page is used

**Example off-chain calculation:**

```typescript
// Before first crank of the day, calculate total_locked
let total_locked = new BN(0);
for (const investor of allInvestors) {
  const streamData = await connection.getAccountInfo(investor.streamAccount);
  const locked = parseLockedAmount(streamData, currentTime);
  total_locked = total_locked.add(locked);
}

// Pass to first page
await program.methods
  .crankDistribution(0, 50, total_locked)
  .accounts({...})
  .rpc();
```

**Accounts:**

| Account                | Type                                | Mutable | Signer | Description                               |
| ---------------------- | ----------------------------------- | ------- | ------ | ----------------------------------------- |
| `cranker`              | `Signer`                            | No      | Yes    | Anyone (permissionless)                   |
| `vault`                | `UncheckedAccount`                  | No      | No     | Vault identifier                          |
| `position_owner`       | `Account<InvestorFeePositionOwner>` | Yes     | No     | Position owner PDA                        |
| `position`             | `Account<Position>`                 | Yes     | No     | Honorary position                         |
| `pool`                 | `Account<Pool>`                     | No      | No     | CP-AMM pool                               |
| `pool_authority`       | `UncheckedAccount`                  | No      | No     | CP-AMM pool authority                     |
| `quote_mint`           | `InterfaceAccount<Mint>`            | No      | No     | Quote token mint                          |
| `base_mint`            | `InterfaceAccount<Mint>`            | No      | No     | Base token mint                           |
| `quote_vault`          | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Pool quote vault                          |
| `base_vault`           | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Pool base vault                           |
| `treasury_ata`         | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Program quote treasury                    |
| `base_treasury_ata`    | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Program base treasury (should stay empty) |
| `creator_ata`          | `InterfaceAccount<TokenAccount>`    | Yes     | No     | Creator's quote token ATA                 |
| `position_nft_account` | `InterfaceAccount<TokenAccount>`    | No      | No     | Position NFT account                      |
| `policy`               | `Account<Policy>`                   | No      | No     | Policy PDA                                |
| `progress`             | `Account<DistributionProgress>`     | Yes     | No     | Progress PDA                              |
| `streamflow_program`   | `UncheckedAccount`                  | No      | No     | Streamflow program                        |
| `cp_amm_program`       | `Program`                           | No      | No     | CP-AMM program                            |
| `token_program`        | `Interface`                         | No      | No     | Token program                             |

**Remaining Accounts (pairs, in order):**

1. Streamflow Contract account (read-only)
2. Investor quote token ATA (writable)
3. (Repeat for each investor in the page)

**PDA Seeds:**

- Position Owner: `["vault", vault.key(), "investor_fee_pos_owner"]`
- Policy: `["policy", vault.key()]`
- Progress: `["progress", vault.key()]`
- Treasury: `["treasury", vault.key(), mint.key()]`

**24-Hour Window Logic:**

- First crank of the day requires: `now >= last_distribution_ts + 86400`
- Subsequent pages within same day: shares same timestamp
- Day resets after 86400 seconds (24 hours)

**Pagination:**

- `page_size` max: 50 (MAX_PAGE_SIZE)
- Pages are processed sequentially: page 1, page 2, etc.
- Safe to retry/resume mid-day after partial success
- Creator payout occurs only on final page when all investors processed

**Distribution Math:**

```rust
// Calculate eligible investor share based on locked percentage
locked_total = sum(still_locked_i) across all investors
f_locked = locked_total / Y0                    // fraction locked (0-1)
eligible_investor_share_bps = min(investor_fee_share_bps, floor(f_locked * 10000))

// Calculate investor and creator portions
investor_fee_quote = floor(claimed_quote * eligible_investor_share_bps / 10000)
creator_fee_quote = claimed_quote - investor_fee_quote

// Distribute to each investor pro-rata
weight_i = locked_i / locked_total
payout_i = floor(investor_fee_quote * weight_i)
```

**Safety Guarantees:**

- If any base fees detected, crank fails with `BaseFeesDetected` - **NO distribution occurs**
- Daily cap enforced (if set)
- Minimum payout threshold enforced
- Dust carried forward to next distribution
- Idempotent: re-running same page doesn't double-pay

**Events Emitted:**

- `QuoteFeesClaimed` (once per day)
- `InvestorPayoutPage` (once per page)
- `CreatorPayoutDayClosed` (once per day, on final page)

## PDA Derivations

All PDAs use standard Anchor derivation with bumps stored in account state.

| PDA                  | Seeds                                               | Bump Location                              |
| -------------------- | --------------------------------------------------- | ------------------------------------------ |
| **Position Owner**   | `["vault", vault_pubkey, "investor_fee_pos_owner"]` | `position_owner.bump`                      |
| **Policy**           | `["policy", vault_pubkey]`                          | `policy.bump`                              |
| **Progress**         | `["progress", vault_pubkey]`                        | `progress.bump`                            |
| **Treasury (Quote)** | `["treasury", vault_pubkey, quote_mint_pubkey]`     | Derived from `position_owner` as authority |
| **Treasury (Base)**  | `["treasury", vault_pubkey, base_mint_pubkey]`      | Derived from `position_owner` as authority |

**Example Derivation:**

```typescript
const [positionOwnerPda, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    vaultPubkey.toBuffer(),
    Buffer.from("investor_fee_pos_owner"),
  ],
  programId
);
```

## State Accounts

### InvestorFeePositionOwner

Owns the CP-AMM position NFT and stores position references.

```rust
pub struct InvestorFeePositionOwner {
    pub vault: Pubkey,           // Vault identifier
    pub pool: Pubkey,            // CP-AMM pool
    pub position: Pubkey,        // CP-AMM position account
    pub position_mint: Pubkey,   // Position NFT mint
    pub quote_mint: Pubkey,      // Quote token mint
    pub base_mint: Pubkey,       // Base token mint
    pub bump: u8,                // PDA bump
}
```

### Policy

Stores distribution parameters.

```rust
pub struct Policy {
    pub vault: Pubkey,                    // Vault identifier
    pub creator_wallet: Pubkey,           // Receives remainder
    pub investor_fee_share_bps: u16,      // 0-10000 (30% = 3000)
    pub daily_cap_lamports: Option<u64>,  // Optional cap
    pub min_payout_lamports: u64,         // Min threshold (≥1000)
    pub y0_total_allocation: u64,         // TGE total allocation
    pub bump: u8,                         // PDA bump
    pub created_at: i64,                  // Creation timestamp
    pub updated_at: i64,                  // Last update timestamp
}
```

### DistributionProgress

Tracks daily distribution state for idempotent pagination.

```rust
pub struct DistributionProgress {
    pub vault: Pubkey,                 // Vault identifier
    pub last_distribution_ts: i64,     // Last crank timestamp
    pub total_distributed_today: u64,  // Running total for day
    pub dust_carried_forward: u64,     // Dust from previous distributions
    pub current_page: u32,             // Current page being processed
    pub is_day_complete: bool,         // Creator payout sent?
    pub bump: u8,                      // PDA bump
}
```

## Events

### HonoraryPositionInitialized

```rust
pub struct HonoraryPositionInitialized {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub quote_mint: Pubkey,
    pub position_owner: Pubkey,
    pub timestamp: i64,
}
```

### QuoteFeesClaimed

```rust
pub struct QuoteFeesClaimed {
    pub vault: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
```

### InvestorPayoutPage

```rust
pub struct InvestorPayoutPage {
    pub vault: Pubkey,
    pub page_start: u32,
    pub page_size: u32,
    pub investors_paid: u32,
    pub total_paid: u64,
    pub dust_carried: u64,
    pub timestamp: i64,
}
```

### CreatorPayoutDayClosed

```rust
pub struct CreatorPayoutDayClosed {
    pub vault: Pubkey,
    pub creator_amount: u64,
    pub total_distributed: u64,
    pub timestamp: i64,
}
```

## Error Codes

| Code | Name                          | Description                                                  | When It Occurs                                                 |
| ---- | ----------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| 6000 | `QuoteOnlyValidationFailed`   | Pool configuration allows base token fees                    | Position initialization with incompatible pool                 |
| 6001 | `BaseFeesDetected`            | Base token fees detected during claim - distribution aborted | Crank detects non-zero base fees                               |
| 6002 | `CrankWindowNotReached`       | 24-hour crank window not reached                             | Attempting crank before 24h elapsed                            |
| 6003 | `InvalidPagination`           | Invalid pagination parameters                                | page_size > 50 or invalid page_start                           |
| 6004 | `InsufficientStreamflowData`  | Cannot read locked amounts from Streamflow                   | Malformed Streamflow account data                              |
| 6005 | `DistributionAlreadyComplete` | Distribution already completed for this day                  | Attempting to re-run final page                                |
| 6006 | `InvalidPoolConfiguration`    | Pool not compatible with quote-only requirements             | Position init with wrong pool setup, or invalid BPS/thresholds |
| 6007 | `MathOverflow`                | Math overflow in distribution calculations                   | Overflow in checked arithmetic                                 |
| 6008 | `AccountCountMismatch`        | Investor ATA count mismatch with Streamflow accounts         | Remaining accounts not paired correctly                        |
| 6009 | `DailyCapExceeded`            | Daily distribution cap exceeded                              | Attempting to distribute beyond daily cap                      |
| 6010 | `InvalidPositionOwnership`    | Position not owned by program PDA                            | Position owner mismatch                                        |

## Day & Pagination Semantics

### 24-Hour Window

The crank operates on a **24-hour sliding window** based on Unix timestamps:

1. **First crank of the day:**

   - Requires: `current_time >= last_distribution_ts + 86400`
   - Claims fees from CP-AMM position
   - Stores timestamp in `progress.last_distribution_ts`
   - Initializes `total_distributed_today = 0`

2. **Subsequent pages (same day):**

   - Uses same `last_distribution_ts` (no 24h check)
   - Accumulates to `total_distributed_today`
   - Tracks `current_page` for resumability

3. **Day completion:**
   - Final page (when all investors processed) sends creator payout
   - Sets `is_day_complete = true`
   - Next crank must wait full 24 hours

### Pagination Flow

For **N investors** with **page_size=50**:

```
Page 1: crank_distribution(0, 50)    → Processes investors [0-49]
Page 2: crank_distribution(50, 50)   → Processes investors [50-99]
Page 3: crank_distribution(100, 50)  → Processes investors [100-149]
...
Final:  crank_distribution(200, 50)  → Processes remaining, pays creator
```

**Key Properties:**

- **Idempotent**: Re-running same page with same parameters is safe
- **Resumable**: If page 2 fails, can retry page 2 without affecting page 1 payouts
- **Atomic per page**: Either entire page succeeds or entire page fails
- **Creator payment**: Only occurs on final page after all investors paid
- **Dust handling**: Remainders from floor division carried in `dust_carried_forward`

### Daily Cap Behavior

If `daily_cap_lamports` is set:

```rust
remaining_cap = daily_cap - total_distributed_today
if payout_amount > remaining_cap {
    actual_payout = remaining_cap
    carry_forward = payout_amount - remaining_cap
}
```

Excess is carried to next day's distribution.

## Integration Example

### Complete Flow

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Honourary } from "./target/types/honourary";

const program = anchor.workspace.honourary as Program<Honourary>;
const vaultKeypair = anchor.web3.Keypair.generate();

// Step 1: Setup Policy
const [policyPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("policy"), vaultKeypair.publicKey.toBuffer()],
  program.programId
);

const [progressPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("progress"), vaultKeypair.publicKey.toBuffer()],
  program.programId
);

await program.methods
  .setupPolicy({
    creatorWallet: creatorPubkey,
    investorFeeShareBps: 3000,
    dailyCapLamports: new anchor.BN(1000000),
    minPayoutLamports: new anchor.BN(1000),
    y0TotalAllocation: new anchor.BN(100000000),
  })
  .accountsPartial({
    authority: creatorPubkey,
    payer: payer.publicKey,
    vault: vaultKeypair.publicKey,
    policy: policyPda,
    progress: progressPda,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .signers([payer])
  .rpc();

// Step 2: Initialize Honorary Position
const [positionOwnerPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    vaultKeypair.publicKey.toBuffer(),
    Buffer.from("investor_fee_pos_owner"),
  ],
  program.programId
);

const positionNftMint = anchor.web3.Keypair.generate();

await program.methods
  .initializeHonoraryPosition()
  .accountsPartial({
    payer: payer.publicKey,
    vault: vaultKeypair.publicKey,
    positionOwnerPda: positionOwnerPda,
    pool: poolPubkey,
    quoteMint: quoteMintPubkey,
    baseMint: baseMintPubkey,
    positionNftMint: positionNftMint.publicKey,
    // ... other accounts
  })
  .signers([payer, positionNftMint])
  .rpc();

// Step 3: Crank Distribution (after 24h, with investor data)
const investorAccounts = [];
for (const investor of investors) {
  investorAccounts.push(
    { pubkey: investor.streamflowContract, isSigner: false, isWritable: false },
    { pubkey: investor.quoteAta, isSigner: false, isWritable: true }
  );
}

await program.methods
  .crankDistribution(0, 50)
  .accountsPartial({
    cranker: cranker.publicKey,
    vault: vaultKeypair.publicKey,
    positionOwner: positionOwnerPda,
    // ... other accounts
  })
  .remainingAccounts(investorAccounts)
  .signers([cranker])
  .rpc();
```

## Failure Modes

| Scenario                          | Behavior                                             | Recovery                                 |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| **Base fees detected**            | Crank fails with `BaseFeesDetected`, no distribution | Fix pool configuration, retry after 24h  |
| **Insufficient treasury balance** | Transfer fails, page fails                           | Add quote tokens to treasury, retry page |
| **Invalid Streamflow data**       | Fails with `InsufficientStreamflowData`              | Verify Streamflow accounts, retry        |
| **Crank too early**               | Fails with `CrankWindowNotReached`                   | Wait until 24h elapsed                   |
| **Page size too large**           | Fails with `InvalidPagination`                       | Use page_size ≤ 50                       |
| **Missing investor ATA**          | Page fails with account error                        | Create ATA, retry page                   |
| **Network timeout mid-page**      | Page may partially succeed                           | Retry same page (idempotent)             |
| **Daily cap reached**             | Remaining payouts carried to next day                | Normal operation, crank again after 24h  |

## Testing

### Running Tests

```bash
# Run all tests (unit + integration)
anchor test

# Run specific test file
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/feeRouter.test.ts
```

### Streamflow Program Setup

The tests use the **real Streamflow program** from mainnet, loaded into bankrun for realistic integration testing.

**Setup (already complete):**

1. **Program binary**: Downloaded from mainnet and stored in `tests/fixtures/streamflow.so` (1.0MB)
2. **Test configuration**: Streamflow program automatically loaded in test context (see `tests/bankrun-utils/common.ts:39-42`)
3. **Stream account structure**: Mock streams use exact Contract layout (1104 bytes as per `METADATA_LEN`)

**To update the Streamflow program:**

```bash
# Download latest version from mainnet
solana program dump strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m tests/fixtures/streamflow.so --url mainnet-beta
```

**Benefits of real program integration:**
- ✅ Tests against actual Streamflow SDK deserialization
- ✅ Matches mainnet behavior exactly
- ✅ No mocks - stream accounts use real Contract structure
- ✅ Bankrun keeps tests fast while using real program

### Test Suite Overview

This project includes three test suites:

#### 1. Unit Tests (`tests/honourary.ts`)

- Policy setup and validation
- Position initialization structure
- PDA derivation correctness
- Pro-rata distribution math (off-chain simulation)
- Quote-only validation logic
- Multi-page pagination math
- Edge cases (dust, caps, overflow protection)

#### 2. Integration Tests (`tests/integration-real.ts`)

- **Documents** real CP-AMM and Streamflow integration
- Explains position creation flow with quote-only pools
- Demonstrates Streamflow vesting contract parsing
- Verifies distribution math accuracy
- Tests multi-page consistency
- Validates safety mechanisms (base fee rejection, 24h window)
- Provides mainnet deployment checklist

**Note on Integration Tests**: The integration test file uses cloned mainnet programs (configured in `Anchor.toml`) and provides comprehensive documentation of how to integrate with real CP-AMM pools and Streamflow contracts. Full end-to-end testing requires:

1. Creating a real CP-AMM pool with `collect_fee_mode` set to quote-only
2. Creating real Streamflow vesting contracts for investors
3. Generating fees through swaps in the pool

See `tests/integration-real.ts` for detailed integration instructions and examples.

#### 3. Surfpool Integration Tests (`tests/surfpool-integration.ts`)

- **Uses Surfpool MCP** for real on-chain state manipulation
- Tests with actual CP-AMM and Streamflow program behavior
- Verifies distribution math with realistic token amounts
- Validates multi-page pagination with consistent rates
- Demonstrates all safety mechanisms (base fee rejection, 24h window, idempotency)
- Provides complete integration workflow documentation

**Surfpool Testing Benefits**:

- Test against REAL mainnet-cloned programs locally
- Manipulate on-chain state for comprehensive test scenarios
- No mocks or simulations - actual program behavior
- Faster iteration than devnet testing
- Safer than testing directly on mainnet

To use Surfpool tests:

1. Ensure Surfpool MCP is configured and running
2. CP-AMM program copied into `programs/cp-amm`
3. Streamflow SDK available in `resources/streamflow-rust-sdk`
4. Run tests with `pnpm exec ts-mocha tests/surfpool-integration.ts`

### Test Coverage

- ✅ Policy setup and validation
- ✅ Position initialization with quote-only validation
- ✅ PDA derivation correctness
- ✅ Pro-rata distribution math
- ✅ Streamflow locked amount parsing logic
- ✅ CP-AMM integration with correct discriminators
- ✅ All unlocked → 100% to creator
- ✅ Dust carry-over behavior
- ✅ Daily cap enforcement
- ✅ Base-fee rejection (safety)
- ✅ Multi-page pagination with consistent rates
- ✅ Total_locked parameter bug fix verification

## Constants

```rust
pub const SECONDS_PER_DAY: i64 = 86400;
pub const BASIS_POINTS_DIVISOR: u64 = 10000;
pub const PRECISION_MULTIPLIER: u64 = 1_000_000;
pub const MAX_PAGE_SIZE: u32 = 50;
pub const MIN_PAYOUT_THRESHOLD: u64 = 1000;
```

## External Program IDs

```rust
// CP-AMM (DAMM v2)
pub const CP_AMM_PROGRAM_ID: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

// Streamflow
pub const STREAMFLOW_PROGRAM_ID: &str = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";
```

## License

ISC

## Contributing

This module is designed to be imported into larger projects. Key extension points:

- **Custom fee logic**: Modify `calculate_eligible_investor_share` in `policy.rs`
- **Additional validation**: Extend `validate_quote_only_pool` in `utils/validation.rs`
- **Event subscriptions**: Listen to emitted events for off-chain tracking

## Support

For issues or questions about this module, please open an issue in the repository.

---

**Built for the star platform** - Making fundraising transparent and accessible.

# Meteora Constant Product AMM (DAMM v2)

MCPA is a brand new AMM program of Meteora that includes almost all features from dynamic-amm v1 with new features:

- Fixed hot account issue from dynamic-amm v1, each pool includes a set of unique accounts for swap instruction (no shared accounts between 2 pools)
- Support for token2022. All token2022 with metadata pointer and transfer fee extensions are supported permissionlessly. Token mints with other extensions can be whitelisted by Meteora's admin
- Fee is not compounded on LP, which allows us to implement many cool features like: collecting fee only in one token (aka SOL), position NFT, creating permanent lock for position but still being able to claim fee
- Support for base fee scheduler and dynamic fee. In fee scheduler we support 2 modes: linear or exponential, while dynamic fee is based on volatility when users trade with the pool
- Support for a minimal version of concentrated liquidity, where the pool is constant-product but has a price range, allowing liquidity to be more concentrated, hence bringing more volume to pool

## Endpoints

### Admin

- create_config: create a static config key that includes all pre-defined parameters when user create pools with that config key.
- create_dynamic_config: create a dynamic config key that only define pool creator authority.
- create_token_badge: whitelist token mint, that has non-permissionless extensions (token2022)
- create_claim_fee_operator: whitelist an address to claim protocol fee
- close_claim_fee_operato: unwhitelist the address to claim protocol fee
- close_config: close a config key
- initialize_reward: initialize an on-chain liquidity mining for a pool
- update_reward_funder: update a whitelisted address to fund rewards for on-chain liquidity mining
- update_reward_duration: update reward duration for liquidity mining
- set_pool_status: enable or disable pools. If pool is disabled, user can only be able to withdraw, can't add liquidity or swap

### Keeper to claim protocol fee

- claim_protocol_fee: claim protocol fee to Meteora's treasury address

### Token team (who run on-chain liquidity mining)

- fund_reward: fund reward for on-chain liquidity mining
- withdraw_ineligible_reward: withdraw ineligible reward

### Partner (aka Launchpad)

- claim_partner_fee: claim partner fee

### Token deployer

- initialize_pool: create a new pool from a static config key
- initialize_pool_with_dynamic_config: create a new pool from a dynamic config key
- initialize_customizable_pool: create a new pool with customizable parameters, should be only used by token deployer, that token can't be leaked.

### Liquidity provider

- create_position: create a new position nft, that holds liquidity that owner will deposit later
- add_liquidity: add liquidity to a pool
- remove_liquidity: remove liquidity from a pool
- remove_all_liquidity: remove all liquidity from a pool
- claim_position_fee: claim position fee
- lock_position: lock position with a vesting schedule
- refresh_vesting: refresh vesting schedule
- permanent_lock_position: lock position permanently
- claim_reward: claim rewards from on-chain liquidity mining

### Trading bot/ user swap with pools

- swap: swap with the pool

## Config key state

- vault_config_key: alpha-vault address that is able to buy pool before activation_point
- pool_creator_authority: if this address is non-default, then only this address can create pool with that config key (for launchpad)
- pool_fees: includes base fee scheduler, dynamic-fee, protocol fee percent, partner fee percent, and referral fee percent configuration
- activation_type: determines whether pools are run in slot or timestamp
- collect_fee_mode: determines whether pool should collect fees in both tokens or only one token
- sqrt_min_price: square root of min price for pools
- sqrt_max_price: square root of max price for pools

## Development

### Dependencies

- anchor 0.31.0
- solana 2.1.0
- rust 1.85.0

### Build

Program

```
anchor build
```

### Test

```
pnpm install
pnpm test
```

## Deployments

- Mainnet-beta: cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
- Devnet: cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG

## Audits

The program has been audited. You can find the audit report [here](https://docs.meteora.ag/resources/audits#id-2.-damm-v2).
