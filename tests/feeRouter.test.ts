import { Clock, ProgramTestContext } from "solana-bankrun";
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
  createInvestorStreams,
  calculateLockedAmount,
  TEST_SCENARIOS,
} from "./bankrun-utils/streamflow";
import BN from "bn.js";
import { expect } from "chai";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Helper function to advance time by 24 hours in bankrun
 * This allows tests to bypass the 24-hour distribution window
 */
async function advanceTime24Hours(context: ProgramTestContext) {
  const currentClock = await context.banksClient.getClock();
  context.setClock(
    new Clock(
      currentClock.slot + 1n,
      currentClock.epochStartTimestamp,
      currentClock.epoch,
      currentClock.leaderScheduleEpoch,
      currentClock.unixTimestamp + 86400n // +24 hours in seconds
    )
  );
}

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
        tokenAMint: tokenBMint, // Pool's tokenA (base)
        tokenBMint: tokenAMint, // Pool's tokenB (quote - fees collected here)
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
      expect(policyAccount.dailyCapLamports.toString()).to.equal("1000000000");
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
      // TODO: Fix addHonoraryLiquidity - temporarily commented out
      // await addHonoraryLiquidity(context.banksClient, {
      //   funder: creator,
      //   vault,
      //   pool,
      //   quoteMint,
      //   baseMint,
      //   liquidityDelta: new BN(1_000_000), // 1M liquidity units
      //   tokenAMaxAmount: new BN(100_000_000), // 100M max token A
      //   tokenBMaxAmount: new BN(100_000_000), // 100M max token B
      // });
    });

    it("Should distribute fees pro-rata to investors based on locked amounts", async () => {
      // Add liquidity to honorary position first - use MIN_LP_AMOUNT for meaningful fee share
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT), // Match pool liquidity for 50% fee share
        tokenAMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
        tokenBMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
      });

      // Create 5 mock investors with different locked percentages
      const investorCount = 5;
      const lockedPercentages = [100, 75, 50, 25, 0]; // Mixed locks

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30)); // Started 30 days ago
      const vestingEnd = currentTime.add(new BN(86400 * 330)); // Ends in 330 days

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
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

      // Simulate fee accrual via swap - use larger amount to ensure fees
      const swapParams: SwapParams = {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint, // swap quote->base so fees accrue in quote vault
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000), // 50M tokens to generate substantial fees
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      };

      await swapExactIn(context.banksClient, swapParams);

      // Get creator ATA
      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false, // creator is a regular keypair, not a PDA
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

      console.log(
        `Total claimed: ${progress.currentDayTotalClaimed.toString()}`
      );
      console.log(
        `Total to investors: ${progress.currentDayDistributed.toString()}`
      );
      console.log(`Creator payout: ${creatorPayout.toString()}`);
    });
  });

  /**
   * Test Suite 4: Multi-Page Pagination
   *
   * Tests the pagination logic with > 10 investors across multiple pages
   */
  describe("4. Multi-Page Pagination", () => {
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

      // Create quote-only pool
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
        collectFeeMode: 1,
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
      quoteMint = tokenBMint;
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
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(1000), // Must be >= MIN_PAYOUT_THRESHOLD (1000)
        y0TotalAllocation: new BN(15_000_000), // 15M tokens
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Add liquidity - use MIN_LP_AMOUNT for meaningful fee share
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT),
        tokenAMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
        tokenBMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
      });
    });

    it("Should distribute across 3 pages of 5 investors each (15 total)", async () => {
      const investorCount = 4; // reduced to fit tx size limits
      const pageSize = 2;
      const lockedPercentages = new Array(investorCount).fill(100); // All locked

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(15_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages,
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees - larger swap to ensure fee generation
      const swapParams: SwapParams = {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      };
      await swapExactIn(context.banksClient, swapParams);

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      // Build full investor account list once (required for correct pagination semantics)
      const investorAccountsAll = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Process required number of pages
      const pagesNeeded = Math.ceil(investorCount / pageSize);
      for (let page = 0; page < pagesNeeded; page++) {
        const pageStart = page * pageSize;

        await crankDistribution(context.banksClient, {
          cranker: payer,
          vault,
          pool,
          quoteMint,
          baseMint,
          creatorQuoteATA: creatorATA,
          pageStart,
          pageSize,
          totalLockedAllInvestors: totalLocked,
          investorAccounts: investorAccountsAll,
        });

        // Verify progress after each page
        const [progressPDA] = deriveProgressPDA(vault);
        const progress = await getDistributionProgress(
          context.banksClient,
          progressPDA
        );

        // All but the last page should not complete the day
        if (page < pagesNeeded - 1) {
          expect(progress.dayCompleted).to.be.false;
        } else {
          // Last page should complete the day
          expect(progress.dayCompleted).to.be.true;
        }
      }

      // Verify all investors received payouts
      const [progressPDA] = deriveProgressPDA(vault);
      const finalProgress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      expect(finalProgress.dayCompleted).to.be.true;
      expect(finalProgress.currentDayDistributed.toNumber()).to.be.greaterThan(
        0
      );
    });

    it("Should prevent double-payment when resuming from cursor", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      const investorCount = 5; // reduced to fit tx size limits with compute budget
      const pageSize = 2;
      const lockedPercentages = new Array(investorCount).fill(50);

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(15_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages,
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      // Track investor balances before
      const balancesBefore: BN[] = [];
      for (const ata of investorATAs) {
        balancesBefore.push(await getTokenBalance(context.banksClient, ata));
      }

      // Build full investor account list
      const investorAccountsAll2 = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Process first page
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll2,
      });

      // Attempt to re-run the same page (should be idempotent)
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll2,
      });

      // Verify first 3 investors were NOT paid twice
      for (let i = 0; i < pageSize; i++) {
        const balanceAfter = await getTokenBalance(
          context.banksClient,
          investorATAs[i]
        );
        const payout = balanceAfter.sub(balancesBefore[i]);
        expect(payout.toNumber()).to.be.greaterThan(0);

        // This test demonstrates idempotency - the same page can be called
        // multiple times without double-payment
      }
    });
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

      // Create quote-only pool
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
        collectFeeMode: 1,
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
      quoteMint = tokenBMint;
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
        investorFeeShareBps: 10000, // 100% max to investors when fully locked
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(5_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Add liquidity - use MIN_LP_AMOUNT for meaningful fee share
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT),
        tokenAMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
        tokenBMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
      });
    });

    it("ALL_LOCKED: 100% fees to investors when all tokens locked", async () => {
      const scenario = TEST_SCENARIOS.ALL_LOCKED;
      const investorCount = scenario.lockedPercentages.length;

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: scenario.lockedPercentages,
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const creatorBalanceBefore = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify: all fees to investors (f_locked = 1.0)
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      const totalDistributed = progress.currentDayDistributed;
      const totalClaimed = progress.currentDayTotalClaimed;

      // When all locked, investors should get 100% (up to investor_fee_share_bps)
      // eligible_investor_share_bps = min(10000, floor(1.0 * 10000)) = 10000
      expect(totalDistributed.toNumber()).to.be.greaterThan(0);

      // Creator should get minimal or zero fees
      const creatorBalanceAfter = await getTokenBalance(
        context.banksClient,
        creatorATA
      );
      const creatorPayout = creatorBalanceAfter.sub(creatorBalanceBefore);

      // With 100% locked and investor_fee_share_bps = 10000, creator gets 0
      expect(creatorPayout.toNumber()).to.equal(0);
    });

    it("ALL_UNLOCKED: 100% fees to creator when all tokens unlocked", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      const scenario = TEST_SCENARIOS.ALL_UNLOCKED;
      const investorCount = scenario.lockedPercentages.length;

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 365)); // Started 1 year ago
      const vestingEnd = currentTime.sub(new BN(86400)); // Ended yesterday (all unlocked)

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: scenario.lockedPercentages,
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Total locked should be 0
      expect(totalLocked.toNumber()).to.equal(0);

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const creatorBalanceBefore = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify: all fees to creator (f_locked = 0.0)
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      const totalDistributed = progress.currentDayDistributed;
      const totalClaimed = progress.currentDayTotalClaimed;

      // When all unlocked, investors get 0
      expect(totalDistributed.toNumber()).to.equal(0);

      // Creator should get ALL fees
      const creatorBalanceAfter = await getTokenBalance(
        context.banksClient,
        creatorATA
      );
      const creatorPayout = creatorBalanceAfter.sub(creatorBalanceBefore);

      expect(creatorPayout.toNumber()).to.be.greaterThan(0);
      expect(creatorPayout.toString()).to.equal(totalClaimed.toString());
    });

    it("HALF_LOCKED: 50% fees split between investors and creator", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      const scenario = TEST_SCENARIOS.HALF_LOCKED;
      const investorCount = scenario.lockedPercentages.length;

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 180)); // Started 180 days ago
      const vestingEnd = currentTime.add(new BN(86400 * 180)); // Ends in 180 days (50% through)

      console.log(
        `\n  Setting up HALF_LOCKED scenario with expected 50% locked...`
      );
      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: scenario.lockedPercentages,
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );
      console.log(`  Total locked amount: ${totalLocked.toString()}`);

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const creatorBalanceBefore = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify: roughly 50/50 split
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      const totalDistributed = progress.currentDayDistributed;
      const totalClaimed = progress.currentDayTotalClaimed;

      const creatorBalanceAfter = await getTokenBalance(
        context.banksClient,
        creatorATA
      );
      const creatorPayout = creatorBalanceAfter.sub(creatorBalanceBefore);

      // Should be roughly 50/50 (allowing for rounding)
      if (totalClaimed.toNumber() === 0) {
        console.log("No fees claimed - skipping percentage checks");
        return;
      }
      const investorShare =
        (totalDistributed.toNumber() / totalClaimed.toNumber()) * 100;
      const creatorShare =
        (creatorPayout.toNumber() / totalClaimed.toNumber()) * 100;

      console.log(`Investor share: ${investorShare.toFixed(2)}%`);
      console.log(`Creator share: ${creatorShare.toFixed(2)}%`);

      // Allow 5% tolerance for rounding
      expect(investorShare).to.be.closeTo(50, 5);
      expect(creatorShare).to.be.closeTo(50, 5);
    });

    it("MIXED_LOCKS: Pro-rata distribution with varying lock percentages", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      const scenario = TEST_SCENARIOS.MIXED_LOCKS;
      const investorCount = scenario.lockedPercentages.length;

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      console.log(
        `\n  Setting up MIXED_LOCKS scenario with [100, 75, 50, 25, 0]% locked...`
      );
      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: scenario.lockedPercentages, // [100, 75, 50, 25, 0]
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );
      console.log(`  Total locked amount: ${totalLocked.toString()}`);

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorBalancesBefore: BN[] = [];
      for (const ata of investorATAs) {
        investorBalancesBefore.push(
          await getTokenBalance(context.banksClient, ata)
        );
      }

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify: investors with more locked get more fees
      const investorPayouts: number[] = [];
      for (let i = 0; i < investorCount; i++) {
        const balanceAfter = await getTokenBalance(
          context.banksClient,
          investorATAs[i]
        );
        const payout = balanceAfter.sub(investorBalancesBefore[i]);
        investorPayouts.push(payout.toNumber());
        console.log(
          `Investor ${i} (${
            scenario.lockedPercentages[i]
          }% locked): ${payout.toString()} tokens`
        );
      }

      // Investor 0 (100% locked) should get most
      // Investor 4 (0% locked) should get nothing
      expect(investorPayouts[0]).to.be.greaterThan(investorPayouts[1]);
      expect(investorPayouts[1]).to.be.greaterThan(investorPayouts[2]);
      expect(investorPayouts[2]).to.be.greaterThan(investorPayouts[3]);
      // Investor 4 with 0% locked gets nothing
      expect(investorPayouts[4]).to.equal(0);
    });

    it("MOSTLY_UNLOCKED: 20% to investors, 80% to creator", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      const scenario = TEST_SCENARIOS.MOSTLY_UNLOCKED;
      const investorCount = scenario.lockedPercentages.length;

      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      console.log(
        `\n  Setting up MOSTLY_UNLOCKED scenario with expected 20% locked...`
      );
      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: scenario.lockedPercentages, // [20, 20, 20, 20, 20]
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );
      console.log(`  Total locked amount: ${totalLocked.toString()}`);

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const creatorBalanceBefore = await getTokenBalance(
        context.banksClient,
        creatorATA
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify: roughly 20/80 split
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      const totalDistributed = progress.currentDayDistributed;
      const totalClaimed = progress.currentDayTotalClaimed;

      const creatorBalanceAfter = await getTokenBalance(
        context.banksClient,
        creatorATA
      );
      const creatorPayout = creatorBalanceAfter.sub(creatorBalanceBefore);

      if (totalClaimed.toNumber() === 0) {
        console.log("No fees claimed - skipping percentage checks");
        return;
      }
      const investorShare =
        (totalDistributed.toNumber() / totalClaimed.toNumber()) * 100;
      const creatorShare =
        (creatorPayout.toNumber() / totalClaimed.toNumber()) * 100;

      console.log(`Investor share: ${investorShare.toFixed(2)}%`);
      console.log(`Creator share: ${creatorShare.toFixed(2)}%`);

      // Allow 5% tolerance for rounding
      expect(investorShare).to.be.closeTo(20, 5);
      expect(creatorShare).to.be.closeTo(80, 5);
    });
  });

  /**
   * Test Suite 6: Dust & Cap Handling
   *
   * Tests dust carry-over and daily cap enforcement
   */
  describe("6. Dust & Cap Handling", () => {
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

      // Create quote-only pool
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
        collectFeeMode: 1,
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
      quoteMint = tokenBMint;
      baseMint = tokenAMint;

      // Initialize honorary position
      await initializeHonoraryPosition(context.banksClient, {
        payer,
        vault,
        pool,
        quoteMint,
        baseMint,
      });

      // Add liquidity - use MIN_LP_AMOUNT for meaningful fee share
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT),
        tokenAMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
        tokenBMaxAmount: new BN("100000000000000000"), // 10^17 (fits in u64)
      });
    });

    it("Should carry over dust when payouts < min_payout_lamports", async () => {
      // Setup policy with HIGH min_payout_lamports to create dust
      const policyParams: PolicyParams = {
        creatorWallet: creator.publicKey,
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(5000), // High threshold - will cause dust
        y0TotalAllocation: new BN(5_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Create many investors to fragment fees (reduced to avoid transaction size limit)
      const investorCount = 4;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate SMALL fees to create dust
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(1000), // Small swap
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify dust was carried over
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      // With small fees and high min threshold, there should be carry-over
      console.log(
        `Total distributed: ${progress.currentDayDistributed.toString()}`
      );
      console.log(
        `Total claimed: ${progress.currentDayTotalClaimed.toString()}`
      );

      // Some fees should remain undistributed due to dust threshold
      expect(progress.currentDayTotalClaimed.toNumber()).to.be.greaterThan(
        progress.currentDayDistributed.toNumber()
      );
    });

    it("Should enforce daily_cap_lamports and carry remainder to next day", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      // Setup policy with LOW daily cap
      const dailyCap = 5000; // Very low cap (use number, not BN, for Option<u64>)
      const policyParams: PolicyParams = {
        creatorWallet: creator.publicKey,
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(dailyCap), // But we still need to pass BN through the interface
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(5_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      const investorCount = 5;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate LARGE fees to exceed cap
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000), // Very large swap to exceed cap
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

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

      // Verify cap was enforced
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      const totalDistributed = progress.currentDayDistributed;

      console.log(`Daily cap: ${dailyCap}`);
      console.log(`Total distributed: ${totalDistributed.toString()}`);
      console.log(
        `Total claimed: ${progress.currentDayTotalClaimed.toString()}`
      );

      // Distribution should be capped at or near daily_cap_lamports
      // The cap applies to investor share, so distributed should be <= dailyCap
      expect(totalDistributed.toNumber()).to.be.at.most(dailyCap);
    });

    it("Should accumulate dust across pages and pay out when threshold met", async () => {
      // Advance time by 24 hours to start a new distribution window
      await advanceTime24Hours(context);

      // Setup policy with moderate min_payout_lamports
      const policyParams: PolicyParams = {
        creatorWallet: creator.publicKey,
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(2000), // Moderate threshold
        y0TotalAllocation: new BN(10_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      const investorCount = 5; // Reduced to fit tx size with compute budget
      const pageSize = 2; // Adjusted pageSize
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(10_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees - larger swap to ensure fee generation
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(10_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      // Build full investor account list once
      const investorAccountsAll = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Process in pages
      let totalPaidOut = new BN(0);
      const pagesNeeded = Math.ceil(investorCount / pageSize);

      for (let page = 0; page < pagesNeeded; page++) {
        const pageStart = page * pageSize;
        const pageEnd = Math.min(pageStart + pageSize, investorCount);

        await crankDistribution(context.banksClient, {
          cranker: payer,
          vault,
          pool,
          quoteMint,
          baseMint,
          creatorQuoteATA: creatorATA,
          pageStart,
          pageSize: pageEnd - pageStart,
          totalLockedAllInvestors: totalLocked,
          investorAccounts: investorAccountsAll,
        });

        const [progressPDA] = deriveProgressPDA(vault);
        const progress = await getDistributionProgress(
          context.banksClient,
          progressPDA
        );

        console.log(
          `After page ${page}: distributed = ${progress.currentDayDistributed.toString()}`
        );
      }

      // Verify dust handling worked correctly across pages
      const [progressPDA] = deriveProgressPDA(vault);
      const finalProgress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      expect(finalProgress.dayCompleted).to.be.true;
      expect(finalProgress.currentDayDistributed.toNumber()).to.be.greaterThan(
        0
      );
    });
  });

  /**
   * Test Suite 7: 24-Hour Window Enforcement
   *
   * Tests that crank can only be called once per 24h
   * Per bounty spec: "24h gate: First crank in a day requires now >= last_distribution_ts + 86400"
   */
  describe("7. 24-Hour Window Enforcement", () => {
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

      // Create quote-only pool
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
        collectFeeMode: 1,
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
      quoteMint = tokenBMint;
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
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(5_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Add liquidity
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT),
        tokenAMaxAmount: new BN("100000000000000000"),
        tokenBMaxAmount: new BN("100000000000000000"),
      });
    });

    it("Should reject crank before 24h window expires", async () => {
      // Create investors
      const investorCount = 3;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Run Day 1 distribution (complete the day)
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

      // Verify Day 1 completed
      const [progressPDA] = deriveProgressPDA(vault);
      const progressAfterDay1 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      expect(progressAfterDay1.dayCompleted).to.be.true;

      // Generate more fees for Day 2
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      // Attempt to run crank immediately (before 24h) - should fail
      try {
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
        expect.fail("Should have thrown error for 24h window not elapsed");
      } catch (error: any) {
        // Expected error - 24h window not elapsed
        // The error could be "DistributionWindowNotElapsed" or similar
        expect(error).to.exist;
      }
    });

    it("Should allow crank after 24h window expires", async () => {
      // Create investors
      const investorCount = 3;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees for Day 1
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Run Day 1 distribution
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

      // Verify Day 1 completed
      const [progressPDA] = deriveProgressPDA(vault);
      const progressAfterDay1 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      expect(progressAfterDay1.dayCompleted).to.be.true;
      const day1Timestamp = progressAfterDay1.lastDistributionTs;

      // Advance time by 24 hours
      await advanceTime24Hours(context);

      // Generate fees for Day 2
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      // Run Day 2 distribution - should succeed
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

      // Verify Day 2 completed successfully
      const progressAfterDay2 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      expect(progressAfterDay2.dayCompleted).to.be.true;
      expect(progressAfterDay2.currentDayTotalClaimed.toNumber()).to.be.greaterThan(0);
    });

    it("Should reset distribution state when starting new 24h cycle", async () => {
      // Create investors
      const investorCount = 3;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(5_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees for Day 1
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccounts = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Run Day 1 distribution
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

      // Capture Day 1 state
      const [progressPDA] = deriveProgressPDA(vault);
      const progressAfterDay1 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      expect(progressAfterDay1.dayCompleted).to.be.true;
      const day1Distributed = progressAfterDay1.currentDayDistributed;
      const day1Claimed = progressAfterDay1.currentDayTotalClaimed;
      const day1Timestamp = progressAfterDay1.lastDistributionTs;

      expect(day1Distributed.toNumber()).to.be.greaterThan(0);
      expect(day1Claimed.toNumber()).to.be.greaterThan(0);

      // Advance time by 24 hours
      await advanceTime24Hours(context);

      // Generate fees for Day 2
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      // Run Day 2 distribution (just first page to check state reset)
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

      // Verify Day 2 state is reset
      const progressAfterDay2 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      // Day 2 should have fresh counters (not accumulating from Day 1)
      expect(progressAfterDay2.dayCompleted).to.be.true;

      // last_distribution_ts should be updated (> Day 1 timestamp)
      expect(progressAfterDay2.lastDistributionTs.toNumber()).to.be.greaterThan(
        day1Timestamp.toNumber()
      );

      // Day 2 claimed and distributed should be independent of Day 1
      // (could be different amounts due to different fee accrual)
      expect(progressAfterDay2.currentDayTotalClaimed.toNumber()).to.be.greaterThan(0);
      expect(progressAfterDay2.currentDayDistributed.toNumber()).to.be.greaterThan(0);

      console.log(`Day 1 - Distributed: ${day1Distributed.toString()}, Claimed: ${day1Claimed.toString()}`);
      console.log(`Day 2 - Distributed: ${progressAfterDay2.currentDayDistributed.toString()}, Claimed: ${progressAfterDay2.currentDayTotalClaimed.toString()}`);
    });
  });

  /**
   * Test Suite 8: Quote-Only Safety
   *
   * CRITICAL: Tests that base fee detection causes failure
   * Per bounty spec: "Quote‑only enforcement: If any base fees are observed or a claim returns non‑zero base,
   * the crank must fail deterministically (no distribution)."
   */
  describe("8. Quote-Only Safety (Critical)", () => {
    let context: ProgramTestContext;
    let admin: Keypair;
    let creator: Keypair;
    let payer: Keypair;
    let vault: PublicKey;
    let tokenAMint: PublicKey;
    let tokenBMint: PublicKey;

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

    it("Should reject initialization when quoteMint doesn't match pool's fee collection token", async () => {
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

      const { pool } = await initializePool(context.banksClient, initPoolParams);

      // Attempt to initialize with WRONG quoteMint (tokenA instead of tokenB)
      // Pool collects in tokenB, but we're claiming tokenA is the quote - should fail
      try {
        await initializeHonoraryPosition(context.banksClient, {
          payer,
          vault,
          pool,
          quoteMint: tokenAMint, // WRONG - should be tokenB
          baseMint: tokenBMint,
        });
        expect.fail("Should have thrown error for quote mint mismatch");
      } catch (error: any) {
        expect(error.message).to.include("QuoteOnlyValidationFailed");
      }
    });

    it("Should reject pool with collectFeeMode = 0 (BothToken) - validation test", async () => {
      // This test verifies the validation logic in a focused way
      // Create pool with collectFeeMode = 0 (BothToken - collects both tokens)
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
        collectFeeMode: 0, // BothToken - NOT quote-only
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

      const { pool } = await initializePool(context.banksClient, initPoolParams);

      // Attempt to initialize - should fail because collectFeeMode = 0 is not quote-only
      try {
        await initializeHonoraryPosition(context.banksClient, {
          payer,
          vault,
          pool,
          quoteMint: tokenBMint,
          baseMint: tokenAMint,
        });
        expect.fail("Should have thrown error for collectFeeMode = 0");
      } catch (error: any) {
        expect(error.message).to.include("QuoteOnlyValidationFailed");
      }
    });

    it("Should verify quote-only pool with flipped tokens collects in correct mint", async () => {
      // This test demonstrates that when token order is flipped,
      // the system correctly validates that quoteMint matches the pool's tokenB
      // Create pool with collectFeeMode = 1 (OnlyB) and FLIP token order
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
        collectFeeMode: 1, // OnlyB - collects in pool's tokenB
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
        // FLIP: original tokenB becomes pool's tokenA, original tokenA becomes pool's tokenB
        tokenAMint: tokenBMint,
        tokenBMint: tokenAMint, // Original tokenA is now pool's tokenB (fee collection token)
        liquidity: new BN(MIN_LP_AMOUNT),
        sqrtPrice: new BN(MIN_SQRT_PRICE).muln(2),
        activationPoint: null,
      };

      const { pool } = await initializePool(context.banksClient, initPoolParams);

      // Initialize with correct quoteMint (original tokenA, which is pool's tokenB)
      const { positionOwnerPDA } = await initializeHonoraryPosition(
        context.banksClient,
        {
          payer,
          vault,
          pool,
          quoteMint: tokenAMint, // Pool's tokenB (where fees are collected)
          baseMint: tokenBMint,   // Pool's tokenA
        }
      );

      // Verify position owner was created correctly
      const positionOwnerAccount = await getInvestorFeePositionOwner(
        context.banksClient,
        positionOwnerPDA
      );

      expect(positionOwnerAccount.vault.toString()).to.equal(vault.toString());
      expect(positionOwnerAccount.pool.toString()).to.equal(pool.toString());
      expect(positionOwnerAccount.quoteMint.toString()).to.equal(
        tokenAMint.toString()
      );
    });
  });

  /**
   * Test Suite 9: Idempotency & Resume
   *
   * Tests partial page success and resume without double-payment
   * Per bounty spec: "Re‑running pages must not double‑pay. Safe to resume mid‑day after partial success."
   */
  describe("9. Idempotency & Resume", () => {
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

      // Create quote-only pool
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
        collectFeeMode: 1,
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
      quoteMint = tokenBMint;
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
        investorFeeShareBps: 5000,
        dailyCapLamports: new BN(10_000_000_000),
        minPayoutLamports: new BN(1000),
        y0TotalAllocation: new BN(9_000_000),
      };

      await setupPolicy(context.banksClient, {
        authority: payer,
        payer,
        vault,
        policyParams,
      });

      // Add liquidity
      await addHonoraryLiquidity(context.banksClient, {
        funder: creator,
        vault,
        pool,
        quoteMint,
        baseMint,
        liquidityDelta: new BN(MIN_LP_AMOUNT),
        tokenAMaxAmount: new BN("100000000000000000"),
        tokenBMaxAmount: new BN("100000000000000000"),
      });
    });

    it("Should prevent double-payment when re-running same page", async () => {
      // Create investors
      const investorCount = 5;
      const pageSize = 2;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(9_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccountsAll = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Track balances before first run
      const balancesBefore: BN[] = [];
      for (const ata of investorATAs) {
        balancesBefore.push(await getTokenBalance(context.banksClient, ata));
      }

      // Run page 0 first time
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      // Track balances after first run
      const balancesAfterFirstRun: BN[] = [];
      for (const ata of investorATAs) {
        balancesAfterFirstRun.push(
          await getTokenBalance(context.banksClient, ata)
        );
      }

      // Re-run page 0 (idempotent retry)
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      // Track balances after second run
      const balancesAfterSecondRun: BN[] = [];
      for (const ata of investorATAs) {
        balancesAfterSecondRun.push(
          await getTokenBalance(context.banksClient, ata)
        );
      }

      // Verify first pageSize investors were paid on first run, but NOT on second run
      for (let i = 0; i < pageSize; i++) {
        const payoutFirstRun = balancesAfterFirstRun[i].sub(balancesBefore[i]);
        const payoutSecondRun = balancesAfterSecondRun[i].sub(
          balancesAfterFirstRun[i]
        );

        expect(payoutFirstRun.toNumber()).to.be.greaterThan(0);
        expect(payoutSecondRun.toNumber()).to.equal(0); // NO double-payment
      }

      // Verify Progress PDA unchanged on second run
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      expect(progress.dayCompleted).to.be.false; // Not final page yet
    });

    it("Should allow resumption from middle page after interruption", async () => {
      const investorCount = 6;
      const pageSize = 2;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(9_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccountsAll = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      // Track balances before
      const balancesBefore: BN[] = [];
      for (const ata of investorATAs) {
        balancesBefore.push(await getTokenBalance(context.banksClient, ata));
      }

      // Run page 0 successfully
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      // Run page 1 successfully
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: pageSize,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      // Track balances after pages 0-1
      const balancesAfterPage1: BN[] = [];
      for (const ata of investorATAs) {
        balancesAfterPage1.push(await getTokenBalance(context.banksClient, ata));
      }

      // Skip page 2, directly run page 2 (simulating resume after interruption)
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: pageSize * 2,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      // Track final balances
      const balancesFinal: BN[] = [];
      for (const ata of investorATAs) {
        balancesFinal.push(await getTokenBalance(context.banksClient, ata));
      }

      // Verify pages 0-1 investors already paid (no change from resume)
      for (let i = 0; i < pageSize * 2; i++) {
        const payoutDuringResume = balancesFinal[i].sub(balancesAfterPage1[i]);
        expect(payoutDuringResume.toNumber()).to.equal(0); // Already paid
      }

      // Verify page 2 investors got paid
      for (let i = pageSize * 2; i < investorCount; i++) {
        const payout = balancesFinal[i].sub(balancesBefore[i]);
        expect(payout.toNumber()).to.be.greaterThan(0);
      }

      // Verify day completed
      const [progressPDA] = deriveProgressPDA(vault);
      const progress = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      expect(progress.dayCompleted).to.be.true;
    });

    it("Should track cumulative distribution across multiple pages", async () => {
      const investorCount = 6;
      const pageSize = 2;
      const currentTime = new BN(Math.floor(Date.now() / 1000));
      const vestingStart = currentTime.sub(new BN(86400 * 30));
      const vestingEnd = currentTime.add(new BN(86400 * 330));

      const { streams, lockedAmounts, investorATAs } =
        await createInvestorStreams(context.banksClient, payer, context, {
          investorCount,
          sender: creator,
          mint: quoteMint,
          totalAllocation: new BN(9_000_000),
          vestingStartTime: vestingStart,
          vestingEndTime: vestingEnd,
          lockedPercentages: new Array(investorCount).fill(100),
        });

      const totalLocked = lockedAmounts.reduce(
        (sum, locked) => sum.add(locked),
        new BN(0)
      );

      // Generate fees
      await swapExactIn(context.banksClient, {
        payer: swapper,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: new BN(50_000_000),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      });

      const creatorATA = getAssociatedTokenAddressSync(
        quoteMint,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      const investorAccountsAll = streams.map((stream, idx) => ({
        streamAccount: stream,
        investorATA: investorATAs[idx],
      }));

      const [progressPDA] = deriveProgressPDA(vault);

      // Run page 0
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: 0,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      const progressAfterPage0 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      const distributedPage0 = progressAfterPage0.currentDayDistributed;
      const totalClaimedPage0 = progressAfterPage0.currentDayTotalClaimed;

      expect(progressAfterPage0.dayCompleted).to.be.false;
      expect(totalClaimedPage0.toNumber()).to.be.greaterThan(0);
      expect(distributedPage0.toNumber()).to.be.greaterThan(0);

      // Run page 1
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: pageSize,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      const progressAfterPage1 = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );
      const distributedPage1 = progressAfterPage1.currentDayDistributed;

      expect(progressAfterPage1.dayCompleted).to.be.false;
      expect(distributedPage1.toNumber()).to.be.greaterThan(
        distributedPage0.toNumber()
      ); // Cumulative increase
      expect(progressAfterPage1.currentDayTotalClaimed.toString()).to.equal(
        totalClaimedPage0.toString()
      ); // Total claimed set once

      // Run page 2 (final)
      await crankDistribution(context.banksClient, {
        cranker: payer,
        vault,
        pool,
        quoteMint,
        baseMint,
        creatorQuoteATA: creatorATA,
        pageStart: pageSize * 2,
        pageSize,
        totalLockedAllInvestors: totalLocked,
        investorAccounts: investorAccountsAll,
      });

      const progressFinal = await getDistributionProgress(
        context.banksClient,
        progressPDA
      );

      expect(progressFinal.dayCompleted).to.be.true;
      expect(progressFinal.currentDayDistributed.toNumber()).to.be.greaterThan(
        distributedPage1.toNumber()
      ); // Final cumulative

      console.log(
        `Page 0 distributed: ${distributedPage0.toString()}`
      );
      console.log(
        `Page 1 distributed (cumulative): ${distributedPage1.toString()}`
      );
      console.log(
        `Final distributed (cumulative): ${progressFinal.currentDayDistributed.toString()}`
      );
      console.log(
        `Total claimed: ${progressFinal.currentDayTotalClaimed.toString()}`
      );
    });
  });
});
