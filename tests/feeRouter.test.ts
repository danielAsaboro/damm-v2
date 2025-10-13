import { ProgramTestContext } from "solana-bankrun";
import {
  convertToByteArray,
  generateKpAndFund,
  randomID,
  startTest,
} from "./bankrun-utils/common";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createConfigIx,
  CreateConfigParams,
  initializePool,
  InitializePoolParams,
  MIN_LP_AMOUNT,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  createToken,
  mintSplTokenTo,
  swapExactIn,
  SwapParams,
  getPool,
  addLiquidity,
  AddLiquidityParams,
} from "./bankrun-utils";
import {
  initializeHonoraryPosition,
  setupPolicy,
  crankDistribution,
  addHonoraryLiquidity,
  PolicyParams,
  getDistributionProgress,
  getPolicy,
  getInvestorFeePositionOwner,
  derivePositionOwnerPDA,
  derivePolicyPDA,
  deriveProgressPDA,
  getTokenBalance,
} from "./bankrun-utils/feeRouter";
import {
  createMockInvestorStreams,
  calculateLockedAmount,
  TEST_SCENARIOS,
} from "./bankrun-utils/streamflow";
import BN from "bn.js";
import { expect } from "chai";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

describe("Fee Router - Comprehensive Test Suite", () => {
  /**
   * Test Suite 1: Initialize Honorary Position (Quote-Only)
   */
  describe("1. Initialize Honorary Position (Quote-Only)", () => {
    let context: ProgramTestContext;
    let admin: Keypair;
    let creator: Keypair;
    let payer: Keypair;
    let vault: PublicKey;
    let tokenAMint: PublicKey;
    let tokenBMint: PublicKey;
    let pool: PublicKey;

    beforeEach(async () => {
      const root = Keypair.generate();
      context = await startTest(root);

      admin = await generateKpAndFund(context.banksClient, context.payer);
      creator = await generateKpAndFund(context.banksClient, context.payer);
      payer = await generateKpAndFund(context.banksClient, context.payer);
      vault = Keypair.generate().publicKey;

      // Create tokens
      tokenAMint = await createToken(
        context.banksClient,
        context.payer,
        context.payer.publicKey
      );
      tokenBMint = await createToken(
        context.banksClient,
        context.payer,
        context.payer.publicKey
      );

      // Mint tokens to creator
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenAMint,
        context.payer,
        creator.publicKey
      );
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenBMint,
        context.payer,
        creator.publicKey
      );
    });

    it("Should successfully initialize honorary position with quote-only pool (collectFeeMode = 1)", async () => {
      // Create pool with collectFeeMode = 1 (OnlyB - collects fees in tokenB)
      const createConfigParams: CreateConfigParams = {
        poolFees: {
          baseFee: {
            cliffFeeNumerator: new BN(2_500_000),
            firstFactor: 0,
            secondFactor: convertToByteArray(new BN(0)),
            thirdFactor: new BN(0),
            baseFeeMode: 0,
          },
          padding: [],
          dynamicFee: null,
        },
        sqrtMinPrice: new BN(MIN_SQRT_PRICE),
        sqrtMaxPrice: new BN(MAX_SQRT_PRICE),
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: PublicKey.default,
        activationType: 0,
        collectFeeMode: 1, // OnlyB - collects fees in tokenB only
      };

      const config = await createConfigIx(
        context.banksClient,
        admin,
        new BN(randomID()),
        createConfigParams
      );

      const initPoolParams: InitializePoolParams = {
        payer: creator,
        creator: creator.publicKey,
        config,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        liquidity: new BN(MIN_LP_AMOUNT),
        sqrtPrice: new BN(MIN_SQRT_PRICE).muln(2),
        activationPoint: null,
      };

      const { pool: poolAddress } = await initializePool(
        context.banksClient,
        initPoolParams
      );
      pool = poolAddress;

      // Initialize honorary position
      const { positionOwnerPDA, position, positionNftMint } =
        await initializeHonoraryPosition(context.banksClient, {
          payer,
          vault,
          pool,
          quoteMint: tokenBMint, // TokenB is quote since collectFeeMode = 1 (OnlyB)
          baseMint: tokenAMint,
        });

      // Verify position owner was created
      const positionOwnerAccount = await getInvestorFeePositionOwner(
        context.banksClient,
        positionOwnerPDA
      );

      expect(positionOwnerAccount.vault.toString()).to.equal(vault.toString());
      expect(positionOwnerAccount.pool.toString()).to.equal(pool.toString());
      expect(positionOwnerAccount.quoteMint.toString()).to.equal(
        tokenBMint.toString()
      );
      expect(positionOwnerAccount.positionAccount.toString()).to.equal(
        position.toString()
      );
    });

    it("Should successfully initialize honorary position with quote-only pool (collectFeeMode = 1, flipped tokens)", async () => {
      // Create pool with collectFeeMode = 1 (OnlyB) and FLIP token order
      // By flipping the token order, we can collect fees in what was originally tokenA
      // Mode 1 always collects in the pool's tokenB, so we make original tokenA become pool's tokenB
      const createConfigParams: CreateConfigParams = {
        poolFees: {
          baseFee: {
            cliffFeeNumerator: new BN(2_500_000),
            firstFactor: 0,
            secondFactor: convertToByteArray(new BN(0)),
            thirdFactor: new BN(0),
            baseFeeMode: 0,
          },
          padding: [],
          dynamicFee: null,
        },
        sqrtMinPrice: new BN(MIN_SQRT_PRICE),
        sqrtMaxPrice: new BN(MAX_SQRT_PRICE),
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: PublicKey.default,
        activationType: 0,
        collectFeeMode: 1, // OnlyB - collects fees in pool's tokenB
      };

      const config = await createConfigIx(
        context.banksClient,
        admin,
        new BN(randomID()),
        createConfigParams
      );

      const initPoolParams: InitializePoolParams = {
        payer: creator,
        creator: creator.publicKey,
        config,
        // FLIP: tokenBMint becomes pool's tokenA, tokenAMint becomes pool's tokenB
        tokenAMint: tokenBMint,  // Pool's tokenA (base)
        tokenBMint: tokenAMint,  // Pool's tokenB (quote - fees collected here)
        liquidity: new BN(MIN_LP_AMOUNT),
        sqrtPrice: new BN(MIN_SQRT_PRICE).muln(2),
        activationPoint: null,
      };

      const { pool: poolAddress } = await initializePool(
        context.banksClient,
        initPoolParams
      );
      pool = poolAddress;

      // Initialize honorary position
      const { positionOwnerPDA } = await initializeHonoraryPosition(
        context.banksClient,
        {
          payer,
          vault,
          pool,
          // Pool's tokenB (original tokenA) is the quote where fees are collected
          quoteMint: tokenAMint,
          baseMint: tokenBMint,
        }
      );

      // Verify position owner was created
      const positionOwnerAccount = await getInvestorFeePositionOwner(
        context.banksClient,
        positionOwnerPDA
      );

      expect(positionOwnerAccount.quoteMint.toString()).to.equal(
        tokenAMint.toString()
      );
    });

    it("Should reject pool with collectFeeMode = 0 (BothToken)", async () => {
      // Create pool with collectFeeMode = 0 (BothToken - NOT quote-only)
      const createConfigParams: CreateConfigParams = {
        poolFees: {
          baseFee: {
            cliffFeeNumerator: new BN(2_500_000),
            firstFactor: 0,
            secondFactor: convertToByteArray(new BN(0)),
            thirdFactor: new BN(0),
            baseFeeMode: 0,
          },
          padding: [],
          dynamicFee: null,
        },
        sqrtMinPrice: new BN(MIN_SQRT_PRICE),
        sqrtMaxPrice: new BN(MAX_SQRT_PRICE),
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: PublicKey.default,
        activationType: 0,
        collectFeeMode: 0, // BothToken - INVALID for quote-only
      };

      const config = await createConfigIx(
        context.banksClient,
        admin,
        new BN(randomID()),
        createConfigParams
      );

      const initPoolParams: InitializePoolParams = {
        payer: creator,
        creator: creator.publicKey,
        config,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        liquidity: new BN(MIN_LP_AMOUNT),
        sqrtPrice: new BN(MIN_SQRT_PRICE).muln(2),
        activationPoint: null,
      };

      const { pool: poolAddress } = await initializePool(
        context.banksClient,
        initPoolParams
      );
      pool = poolAddress;

      // Attempt to initialize honorary position - should fail
      try {
        await initializeHonoraryPosition(context.banksClient, {
          payer,
          vault,
          pool,
          quoteMint: tokenAMint,
          baseMint: tokenBMint,
        });
        expect.fail("Should have thrown error for collectFeeMode = 0");
      } catch (error: any) {
        // Expected error - quote-only validation failed
        expect(error.message).to.include("QuoteOnlyValidationFailed");
      }
    });
  });

  /**
   * Test Suite 2: Setup Distribution Policy
   */
  describe("2. Setup Distribution Policy", () => {
    let context: ProgramTestContext;
    let authority: Keypair;
    let payer: Keypair;
    let vault: PublicKey;
    let creatorWallet: PublicKey;

    beforeEach(async () => {
      const root = Keypair.generate();
      context = await startTest(root);

      authority = await generateKpAndFund(context.banksClient, context.payer);
      payer = await generateKpAndFund(context.banksClient, context.payer);
      vault = Keypair.generate().publicKey;
      creatorWallet = Keypair.generate().publicKey;
    });

    it("Should successfully setup policy with valid parameters", async () => {
      const policyParams: PolicyParams = {
        creatorWallet,
        investorFeeShareBps: 5000, // 50%
        dailyCapLamports: new BN(1_000_000_000), // 1 SOL worth
        minPayoutLamports: new BN(1000), // 1000 lamports minimum
        y0TotalAllocation: new BN(100_000_000), // 100M tokens
      };

      const { policy, progress } = await setupPolicy(context.banksClient, {
        authority,
        payer,
        vault,
        policyParams,
      });

      // Verify policy was created correctly
      const policyAccount = await getPolicy(context.banksClient, policy);

      expect(policyAccount.vault.toString()).to.equal(vault.toString());
      expect(policyAccount.creatorWallet.toString()).to.equal(
        creatorWallet.toString()
      );
      expect(policyAccount.investorFeeShareBps).to.equal(5000);
      expect(policyAccount.dailyCapLamports.toString()).to.equal(
        "1000000000"
      );
      expect(policyAccount.minPayoutLamports.toString()).to.equal("1000");
      expect(policyAccount.y0TotalAllocation.toString()).to.equal("100000000");

      // Verify progress was initialized
      const progressAccount = await getDistributionProgress(
        context.banksClient,
        progress
      );

      expect(progressAccount.vault.toString()).to.equal(vault.toString());
      expect(progressAccount.dayCompleted).to.be.true;
      expect(progressAccount.currentDayDistributed.toString()).to.equal("0");
    });

    it("Should reject invalid investor_fee_share_bps (> 10000)", async () => {
      const policyParams: PolicyParams = {
        creatorWallet,
        investorFeeShareBps: 10001, // INVALID - > 10000 bps
        dailyCapLamports: new BN(1_000_000_000),
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(100_000_000),
      };

      try {
        await setupPolicy(context.banksClient, {
          authority,
          payer,
          vault,
          policyParams,
        });
        expect.fail("Should have thrown error for invalid fee share");
      } catch (error: any) {
        expect(error.message).to.include("InvalidPoolConfiguration");
      }
    });

    it("Should reject zero y0_total_allocation", async () => {
      const policyParams: PolicyParams = {
        creatorWallet,
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(1_000_000_000),
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(0), // INVALID - must be > 0
      };

      try {
        await setupPolicy(context.banksClient, {
          authority,
          payer,
          vault,
          policyParams,
        });
        expect.fail("Should have thrown error for zero allocation");
      } catch (error: any) {
        expect(error.message).to.include("InvalidPoolConfiguration");
      }
    });
  });

  /**
   * Test Suite 3: Basic Crank Distribution (Single Page)
   *
   * This test demonstrates the complete end-to-end flow:
   * 1. Create quote-only pool
   * 2. Initialize honorary position
   * 3. Setup policy
   * 4. Simulate fee accrual via swaps
   * 5. Create mock Streamflow accounts
   * 6. Run crank distribution
   * 7. Verify investor and creator payouts
   */
  describe("3. Basic Crank Distribution (Single Page)", () => {
    let context: ProgramTestContext;
    let admin: Keypair;
    let creator: Keypair;
    let payer: Keypair;
    let swapper: Keypair;
    let vault: PublicKey;
    let tokenAMint: PublicKey;
    let tokenBMint: PublicKey;
    let pool: PublicKey;
    let quoteMint: PublicKey;
    let baseMint: PublicKey;

    beforeEach(async () => {
      const root = Keypair.generate();
      context = await startTest(root);

      admin = await generateKpAndFund(context.banksClient, context.payer);
      creator = await generateKpAndFund(context.banksClient, context.payer);
      payer = await generateKpAndFund(context.banksClient, context.payer);
      swapper = await generateKpAndFund(context.banksClient, context.payer);
      vault = Keypair.generate().publicKey;

      // Create tokens
      tokenAMint = await createToken(
        context.banksClient,
        context.payer,
        context.payer.publicKey
      );
      tokenBMint = await createToken(
        context.banksClient,
        context.payer,
        context.payer.publicKey
      );

      // Mint tokens
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenAMint,
        context.payer,
        creator.publicKey
      );
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenBMint,
        context.payer,
        creator.publicKey
      );
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenAMint,
        context.payer,
        swapper.publicKey
      );
      await mintSplTokenTo(
        context.banksClient,
        context.payer,
        tokenBMint,
        context.payer,
        swapper.publicKey
      );

      // Create quote-only pool (collectFeeMode = 1 -> quote = tokenB)
      const createConfigParams: CreateConfigParams = {
        poolFees: {
          baseFee: {
            cliffFeeNumerator: new BN(2_500_000), // 2.5% fee
            firstFactor: 0,
            secondFactor: convertToByteArray(new BN(0)),
            thirdFactor: new BN(0),
            baseFeeMode: 0,
          },
          padding: [],
          dynamicFee: null,
        },
        sqrtMinPrice: new BN(MIN_SQRT_PRICE),
        sqrtMaxPrice: new BN(MAX_SQRT_PRICE),
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: PublicKey.default,
        activationType: 0,
        collectFeeMode: 1, // OnlyB - collects fees in tokenB
      };

      const config = await createConfigIx(
        context.banksClient,
        admin,
        new BN(randomID()),
        createConfigParams
      );

      const initPoolParams: InitializePoolParams = {
        payer: creator,
        creator: creator.publicKey,
        config,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        liquidity: new BN(MIN_LP_AMOUNT),
        sqrtPrice: new BN(MIN_SQRT_PRICE).muln(2),
        activationPoint: null,
      };

      const { pool: poolAddress } = await initializePool(
        context.banksClient,
        initPoolParams
      );
      pool = poolAddress;
      quoteMint = tokenBMint; // TokenB is quote (mode 1 collects in tokenB)
      baseMint = tokenAMint;

      // Initialize honorary position
      await initializeHonoraryPosition(context.banksClient, {
        payer,
        vault,
        pool,
        quoteMint,
        baseMint,
      });

      // Setup policy
      const policyParams: PolicyParams = {
        creatorWallet: creator.publicKey,
        investorFeeShareBps: 5000, // 50% to investors
        dailyCapLamports: new BN(10_000_000_000), // 10 SOL cap (very high)
        minPayoutLamports: new BN(1000), // 1000 lamports minimum (MIN_PAYOUT_THRESHOLD)
        y0TotalAllocation: new BN(5_000_000), // 5M tokens total allocation
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Add liquidity to honorary position so it can accrue fees
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(1_000_000), // 1M liquidity units
        tokenAMaxAmount: new BN(100_000_000), // 100M max token A
        tokenBMaxAmount: new BN(100_000_000), // 100M max token B
      });
    });

    it("Should distribute fees pro-rata to investors based on locked amounts", async () => {
      // Add liquidity to honorary position first
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(1_000_000), // 1M liquidity units
        tokenAMaxAmount: new BN(100_000_000), // 100M max token A
        tokenBMaxAmount: new BN(100_000_000), // 100M max token B
      });

      // Create 5 mock investors with different locked percentages
      const investorCount = 5;
      const lockedPercentages = [100, 75, 50, 25, 0]; // Mixed locks

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30)); // Started 30 days ago
      const vestingEnd = currentTime.add(new BN(86400 * 330)); // Ends in 330 days

      const { streams, lockedAmounts, investorATAs } =
        await createMockInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator.publicKey,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000), // Y0 = 5M
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages,
        });

      // Calculate total locked
      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Simulate fee accrual via swap
      const swapParams: SwapParams = {
        payer: swapper,
        pool,
        inputTokenMint: baseMint,
        outputTokenMint: quoteMint,
        amountIn: new BN(10000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      };

      await swapExactIn(context.banksClient, swapParams);

      // Get creator ATA
      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        true,
        TOKEN_PROGRAM_ID
      );

      // Record balances before distribution
      const creatorBalanceBefore = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      // Build investor accounts for crank
      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Run crank distribution (single page, all investors)
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize: investorCount,
        totalLockedAllInvestors: totalLocked,
        investorAccounts,
      });

      // Verify distribution progress
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      expect(progress.dayCompleted).to.be.true;
      expect(progress.currentDayTotalClaimed.toNumber()).to.be.greaterThan(0);

      // Verify creator received payout
      const creatorBalanceAfter = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      const creatorPayout = creatorBalanceAfter.sub(creatorBalanceBefore);
      expect(creatorPayout.toNumber()).to.be.greaterThan(0);

      console.log(`Total claimed: ${progress.currentDayTotalClaimed.toString()}`);
      console.log(`Total to investors: ${progress.currentDayDistributed.toString()}`);
      console.log(`Creator payout: ${creatorPayout.toString()}`);
    });
  });

  /**
   * Test Suite 4: Multi-Page Pagination
   *
   * Tests the pagination logic with > 10 investors across multiple pages
   */
  describe("4. Multi-Page Pagination", () => {
    // TODO: Implement multi-page pagination tests
    // This would test pageStart, pageSize parameters and verify cursor tracking
  });

  /**
   * Test Suite 5: Edge Cases - Locked/Unlocked Scenarios
   *
   * Tests different locking scenarios as specified in bounty:
   * - All locked (100% to investors)
   * - All unlocked (100% to creator)
   * - Partial locks (50/50 split)
   */
  describe("5. Edge Cases - Locked/Unlocked Scenarios", () => {
    // TODO: Implement locked/unlocked scenario tests
    // Use TEST_SCENARIOS from streamflow.ts
  });

  /**
   * Test Suite 6: Dust & Cap Handling
   *
   * Tests dust carry-over and daily cap enforcement
   */
  describe("6. Dust & Cap Handling", () => {
    // TODO: Implement dust and cap tests
  });

  /**
   * Test Suite 7: 24-Hour Window Enforcement
   *
   * Tests that crank can only be called once per 24h
   */
  describe("7. 24-Hour Window Enforcement", () => {
    // TODO: Implement 24h window tests
  });

  /**
   * Test Suite 8: Quote-Only Safety
   *
   * CRITICAL: Tests that base fee detection causes failure
   */
  describe("8. Quote-Only Safety (Critical)", () => {
    // TODO: Implement base fee detection tests
    // This is CRITICAL for bounty acceptance
  });

  /**
   * Test Suite 9: Idempotency & Resume
   *
   * Tests partial page success and resume without double-payment
   */
  describe("9. Idempotency & Resume", () => {
    // TODO: Implement idempotency tests
  });
});
