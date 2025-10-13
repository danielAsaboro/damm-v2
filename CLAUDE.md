# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains two Solana Anchor programs:

1. **cp-amm** (`programs/cp-amm/`) - Meteora's Constant Product AMM (DAMM v2)

   - A production AMM program with position NFTs, dynamic fees, and concentrated liquidity
   - Program ID: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`

2. **Fee Router** (`programs/fee_router/`) - Honorary Quote-Only Fee Position Router
   - Creates program-owned DAMM v2 positions that accrue fees exclusively in the quote token
   - Distributes fees pro-rata to investors based on Streamflow vesting schedules
   - Program ID: `EdRezAA3vTNaEifrz4GiF8Kq6LyyQdJ1W5LwtrLwHAS1`

## Build Commands

### Build All Programs

```bash
anchor build
```

### Build with Local Feature (for testing)

```bash
anchor build -- --features local
```

### Run All Tests

```bash
pnpm install
pnpm test
```

This runs: `anchor build -- --features local && pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/*.test.ts`

### Run a Single Test File

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/<filename>.test.ts
```

Examples:

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/honourary.test.ts
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/surfpool-integration.test.ts
```

### Linting

```bash
pnpm lint           # Check formatting
pnpm lint:fix       # Fix formatting
```

## Development Environment

- **Anchor**: 0.31.0
- **Solana**: 2.1.0
- **Rust**: 1.85.0
- **Package Manager**: pnpm 10.18.2
- **Test Framework**: ts-mocha with 1000000ms timeout

## Architecture Overview

### Fee Router Program Structure (honorary concept)

The Fee Router program enables creating program-owned LP positions in DAMM v2 pools that collect fees only in the quote token, then distributes those fees to investors based on their locked token amounts in Streamflow vesting contracts.

**Key Components:**

1. **Three Instructions**:

   - `setup_policy` - Configure distribution parameters (investor share %, daily cap, thresholds)
   - `initialize_honorary_position` - Create a CP-AMM position owned by a program PDA that validates quote-only fee accrual
   - `crank_distribution` - Permissionless 24-hour crank that claims fees and distributes pro-rata with pagination

2. **State Accounts**:

   - `InvestorFeePositionOwner` - PDA that owns the position NFT and stores pool references
   - `Policy` - Stores distribution parameters (investor share, caps, creator wallet)
   - `DistributionProgress` - Tracks daily distribution state for idempotent pagination

3. **Integration Modules** (`src/integrations/`):

   - `cp_amm.rs` - CPI wrappers for CP-AMM program (create_position, claim_position_fee)
   - `streamflow.rs` - Reads locked amounts from Streamflow vesting contracts

4. **PDA Derivation** (`src/utils/pda.rs`):
   - Position Owner: `["vault", vault_pubkey, "investor_fee_pos_owner"]`
   - Policy: `["policy", vault_pubkey]`
   - Progress: `["progress", vault_pubkey]`
   - Treasury ATAs: `["treasury", vault_pubkey, mint_pubkey]`

**Critical Logic:**

- **Quote-only validation**: The program validates during position initialization that the pool configuration ensures ONLY quote token fees are collected. If base fees could be collected, initialization fails with `QuoteOnlyValidationFailed`.

- **Pro-rata distribution math** (`src/utils/math.rs`):

  ```rust
  // Eligible investor share based on locked percentage
  f_locked = sum(still_locked_i) / Y0_total_allocation
  eligible_investor_share_bps = min(investor_fee_share_bps, floor(f_locked * 10000))

  // Split between investors and creator
  investor_fee_quote = floor(claimed_quote * eligible_investor_share_bps / 10000)
  creator_fee_quote = claimed_quote - investor_fee_quote

  // Distribute to each investor
  weight_i = locked_i / sum(locked_all)
  payout_i = floor(investor_fee_quote * weight_i)
  ```

- **Safety guarantee**: If ANY base token fees are detected during cranking, the entire distribution fails with `BaseFeesDetected` - no partial distributions occur.

- **24-hour window**: First crank requires `now >= last_distribution_ts + 86400`. Subsequent pages within the same day share the same timestamp.

- **Pagination**: Max 50 investors per page. Pages are idempotent and resumable. Creator payout occurs only on the final page after all investors are paid.

### CP-AMM Program Structure

The `cp-amm` program is Meteora's production AMM with:

- **Position NFTs**: Each liquidity position is represented by an NFT that can be locked or split
- **Fee Collection Modes**: Can collect fees in both tokens or only in one token (quote-only)
- **Dynamic Fees**: Base fee scheduler (linear/exponential) and volatility-based dynamic fees
- **Concentrated Liquidity**: Price ranges for more efficient capital usage
- **Token2022 Support**: Permissionless support for metadata pointer and transfer fee extensions

**Key Modules:**

- `state/` - Pool, Position, Config, Fee state accounts
- `instructions/` - Organized by actor: admin, initialize_pool, swap, partner
- `math/` - Safe math, fee calculations, u128x128 fixed-point arithmetic
- `curve.rs` - Constant product curve calculations
- `base_fee/` - Fee scheduler and rate limiter logic

### Test Infrastructure

**Bankrun Utils** (`tests/bankrun-utils/`):

- `cpAmm.ts` - Helper functions for CP-AMM operations (create pool, add liquidity, swap)
- `token.ts` / `token2022.ts` - Token mint and account creation utilities
- `alphaVault.ts` - Alpha vault integration for pre-activation trading
- `math.ts` - JavaScript implementations of pool math for test validation

**Test Files**:

- `honourary.test.ts` - Unit tests for Fee Router program logic (honorary concept)
- `surfpool-integration.test.ts` - Real integration tests using Surfpool MCP with actual CP-AMM and Streamflow programs
- Various CP-AMM test files: `swap.test.ts`, `addLiquidity.test.ts`, `claimFee.test.ts`, etc.

## Important Constants

**Fee Router Program**:

```rust
SECONDS_PER_DAY: 86400
BASIS_POINTS_DIVISOR: 10000
PRECISION_MULTIPLIER: 1_000_000
MAX_PAGE_SIZE: 50
MIN_PAYOUT_THRESHOLD: 1000
```

**External Program IDs**:

```rust
CP_AMM_PROGRAM_ID: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
STREAMFLOW_PROGRAM_ID: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"
```

## Working with This Codebase

### When modifying the Fee Router program:

1. **Distribution logic** is in `programs/fee_router/src/instructions/crank_distribution.rs`
2. **Math functions** are in `programs/fee_router/src/utils/math.rs`
3. **Validation logic** is in `programs/fee_router/src/utils/validation.rs`
4. **CP-AMM types** are manually defined in `programs/fee_router/src/cp_amm_types.rs` to avoid compilation issues
5. Always test with `surfpool-integration.test.ts` to verify against real CP-AMM behavior

### When modifying the CP-AMM program:

1. **Swap logic** is in `programs/cp-amm/src/instructions/swap/`
2. **Fee calculations** are in `programs/cp-amm/src/math/fee_math.rs`
3. **Pool state management** is in `programs/cp-amm/src/state/pool.rs`
4. All math operations use checked arithmetic - overflows are errors
5. The program uses fixed-point arithmetic (u128x128) for price calculations

### Test Development:

- Use `solana-bankrun` for fast, deterministic testing
- Import helper functions from `tests/bankrun-utils/` rather than duplicating code
- Set mocha timeout to 1000000ms for complex integration tests
- For CP-AMM integration testing, use the actual program ID in test contexts

### Common Pitfalls:

1. **Directory naming**: The `fee_router` directory contains the Fee Router program
2. **Quote-only validation**: CP-AMM pools must be configured with `collect_fee_mode` set to quote-only for honorary positions
3. **Pagination consistency**: The `total_locked_all_investors` parameter must be calculated off-chain BEFORE the first crank and represents ALL investors, not just the current page
4. **24-hour window**: The crank window is based on Unix timestamps (86400 seconds), not slot-based
5. **Idempotency**: Re-running the same page with the same parameters is safe and won't double-pay
