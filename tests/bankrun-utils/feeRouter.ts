import {
  AnchorProvider,
  BN,
  IdlAccounts,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  clusterApiUrl,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BanksClient } from "solana-bankrun";
import FeeRouterIDL from "../../target/idl/fee_router.json";
import { FeeRouter } from "../../target/types/fee_router";
import { processTransactionMaybeThrow } from "./common";
import { Pool, getPool } from "./cpAmm";
import { STREAMFLOW_PROGRAM_ID } from "./streamflow";
import { derivePoolAuthority } from "./accounts";

export type InvestorFeePositionOwner =
  IdlAccounts<FeeRouter>["investorFeePositionOwner"];
export type Policy = IdlAccounts<FeeRouter>["policy"];
export type DistributionProgress =
  IdlAccounts<FeeRouter>["distributionProgress"];

/**
 * Fee Router program ID
 */
export const FEE_ROUTER_PROGRAM_ID = new PublicKey(
  "5B57SJ3g2YoNXUpsZqqjEQkRSxyKtVTQRXdgAirz6bio"
);

/**
 * CP-AMM program ID (local test program - matches cp-amm/src/lib.rs)
 */
export const CP_AMM_PROGRAM_ID = new PublicKey(
  "ASmKWt93JEMHxbdE6j7znD9y2FcdPboCzC3xtSTJvN7S"
);

/**
 * Seeds for PDA derivation
 */
export const VAULT_SEED = Buffer.from("vault");
export const INVESTOR_FEE_POS_OWNER_SEED = Buffer.from(
  "investor_fee_pos_owner"
);
export const POLICY_SEED = Buffer.from("policy");
export const PROGRESS_SEED = Buffer.from("progress");
export const TREASURY_SEED = Buffer.from("treasury");

/**
 * Create Fee Router program instance for transactions
 */
export function createFeeRouterProgram() {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("devnet")),
    wallet,
    {}
  );
  const program = new Program<FeeRouter>(FeeRouterIDL as FeeRouter, provider);
  return program;
}

/**
 * Derive position owner PDA
 */
export function derivePositionOwnerPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, vault.toBuffer(), INVESTOR_FEE_POS_OWNER_SEED],
    FEE_ROUTER_PROGRAM_ID
  );
}

/**
 * Derive policy PDA
 */
export function derivePolicyPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POLICY_SEED, vault.toBuffer()],
    FEE_ROUTER_PROGRAM_ID
  );
}

/**
 * Derive progress PDA
 */
export function deriveProgressPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PROGRESS_SEED, vault.toBuffer()],
    FEE_ROUTER_PROGRAM_ID
  );
}

/**
 * Derive treasury ATA PDA
 */
export function deriveTreasuryPDA(
  vault: PublicKey,
  mint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TREASURY_SEED, vault.toBuffer(), mint.toBuffer()],
    FEE_ROUTER_PROGRAM_ID
  );
}

/**
 * Derive position address from CP-AMM
 */
export function derivePositionAddress(nftMint: PublicKey): PublicKey {
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), nftMint.toBuffer()],
    CP_AMM_PROGRAM_ID
  );
  return position;
}

/**
 * PolicyParams structure for setup_policy instruction
 */
export interface PolicyParams {
  creatorWallet: PublicKey;
  investorFeeShareBps: number;
  dailyCapLamports: BN;
  minPayoutLamports: BN;
  y0TotalAllocation: BN;
}

/**
 * Parameters for initializing honorary position
 */
export interface InitializeHonoraryPositionParams {
  payer: Keypair;
  vault: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  baseMint: PublicKey;
}

/**
 * Initialize an honorary fee position
 */
export async function initializeHonoraryPosition(
  banksClient: BanksClient,
  params: InitializeHonoraryPositionParams
): Promise<{
  positionOwnerPDA: PublicKey;
  position: PublicKey;
  positionNftMint: PublicKey;
}> {
  const { payer, vault, pool, quoteMint, baseMint } = params;
  const program = createFeeRouterProgram();

  // Derive PDAs
  const [positionOwnerPDA] = derivePositionOwnerPDA(vault);

  // Create position NFT mint keypair (will be initialized by CP-AMM)
  const positionNftMint = Keypair.generate();

  // Derive position address from NFT mint
  const position = derivePositionAddress(positionNftMint.publicKey);

  // Derive position NFT account (CP-AMM creates this as a PDA)
  // seeds = [POSITION_NFT_ACCOUNT_PREFIX, position_nft_mint.key()]
  const [positionNftAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_nft_account", "utf8"),
      positionNftMint.publicKey.toBuffer(),
    ],
    CP_AMM_PROGRAM_ID
  );

  // Get pool authority
  const poolAuthority = derivePoolAuthority();

  // Derive event authority PDA (standard Anchor event_cpi pattern)
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID
  );

  // Derive treasury ATAs
  const [treasuryATA] = deriveTreasuryPDA(vault, quoteMint);
  const [baseTreasuryATA] = deriveTreasuryPDA(vault, baseMint);

  // Determine token programs based on mint accounts
  const quoteMintAccount = await banksClient.getAccount(quoteMint);
  const baseMintAccount = await banksClient.getAccount(baseMint);

  const quoteTokenProgram = quoteMintAccount?.owner || TOKEN_PROGRAM_ID;
  const baseTokenProgram = baseMintAccount?.owner || TOKEN_PROGRAM_ID;

  // CP-AMM requires Token-2022 for position creation
  const tokenProgram = quoteTokenProgram; // For treasury ATA initialization
  const token2022Program = TOKEN_2022_PROGRAM_ID; // For CP-AMM CPI

  const transaction = await program.methods
    .initializeHonoraryPosition()
    .accountsPartial({
      payer: payer.publicKey,
      vault,
      positionOwnerPda: positionOwnerPDA,
      pool,
      quoteMint,
      baseMint,
      positionNftMint: positionNftMint.publicKey,
      positionNftAccount,
      position,
      poolAuthority,
      eventAuthority,
      cpAmmProgramAccount: CP_AMM_PROGRAM_ID,
      treasuryAta: treasuryATA,
      baseTreasuryAta: baseTreasuryATA,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      tokenProgram,
      token2022Program,
      associatedTokenProgram:
        require("@solana/spl-token").ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  transaction.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
  transaction.sign(payer, positionNftMint);

  await processTransactionMaybeThrow(banksClient, transaction);

  return {
    positionOwnerPDA,
    position,
    positionNftMint: positionNftMint.publicKey,
  };
}

/**
 * Parameters for setting up policy
 */
export interface SetupPolicyParams {
  authority: Keypair;
  payer: Keypair;
  vault: PublicKey;
  policyParams: PolicyParams;
}

/**
 * Setup distribution policy
 */
export async function setupPolicy(
  banksClient: BanksClient,
  params: SetupPolicyParams
): Promise<{ policy: PublicKey; progress: PublicKey }> {
  const { authority, payer, vault, policyParams } = params;
  const program = createFeeRouterProgram();

  // Derive PDAs
  const [policy] = derivePolicyPDA(vault);
  const [progress] = deriveProgressPDA(vault);

  const transaction = await program.methods
    .setupPolicy({
      creatorWallet: policyParams.creatorWallet,
      investorFeeShareBps: policyParams.investorFeeShareBps,
      dailyCapLamports: policyParams.dailyCapLamports,
      minPayoutLamports: policyParams.minPayoutLamports,
      y0TotalAllocation: policyParams.y0TotalAllocation,
    })
    .accountsPartial({
      authority: authority.publicKey,
      payer: payer.publicKey,
      vault,
      policy,
      progress,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  transaction.recentBlockhash = (await banksClient.getLatestBlockhash())[0];

  // Sign with both authority and payer
  if (authority.publicKey.toString() === payer.publicKey.toString()) {
    transaction.sign(payer);
  } else {
    transaction.sign(authority, payer);
  }

  await processTransactionMaybeThrow(banksClient, transaction);

  return { policy, progress };
}

/**
 * Parameters for adding honorary liquidity
 */
export interface AddHonoraryLiquidityParams {
  funder: Keypair;
  vault: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  baseMint: PublicKey;
  liquidityDelta: BN;
  tokenAMaxAmount: BN;
  tokenBMaxAmount: BN;
}

/**
 * Add liquidity to the honorary position
 */
export async function addHonoraryLiquidity(
  banksClient: BanksClient,
  params: AddHonoraryLiquidityParams
): Promise<void> {
  const {
    funder,
    vault,
    pool,
    quoteMint,
    baseMint,
    liquidityDelta,
    tokenAMaxAmount,
    tokenBMaxAmount,
  } = params;
  // Guardrails: ensure thresholds are at least 1e9 units to cover slippage but not exceed u64
  const MIN_THRESHOLD = new BN("1000000000");
  const SAFE_TOKEN_A_MAX = tokenAMaxAmount.gt(MIN_THRESHOLD)
    ? tokenAMaxAmount
    : MIN_THRESHOLD;
  const SAFE_TOKEN_B_MAX = tokenBMaxAmount.gt(MIN_THRESHOLD)
    ? tokenBMaxAmount
    : MIN_THRESHOLD;
  const program = createFeeRouterProgram();

  // Derive PDAs
  const [positionOwner] = derivePositionOwnerPDA(vault);
  const positionOwnerAccount = await getInvestorFeePositionOwner(
    banksClient,
    positionOwner
  );
  const position = positionOwnerAccount.positionAccount;
  const positionNftMint = positionOwnerAccount.positionMint;

  // Derive position NFT account
  const [positionNftAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_account", "utf8"), positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID
  );

  // Get pool info to determine vault order
  const poolData = await getPool(banksClient, pool);

  // Dynamically determine which vault is quote and which is base
  // by comparing the pool's token mints with our quote/base mints
  const quoteVault = poolData.tokenBMint.equals(quoteMint)
    ? poolData.tokenBVault
    : poolData.tokenAVault;
  const baseVault = poolData.tokenAMint.equals(baseMint)
    ? poolData.tokenAVault
    : poolData.tokenBVault;

  // Get funder token accounts
  const funderQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    funder.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const funderBaseAccount = getAssociatedTokenAddressSync(
    baseMint,
    funder.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  // Derive treasury ATAs (PDA-owned intermediate accounts)
  const [quoteTreasury] = deriveTreasuryPDA(vault, quoteMint);
  const [baseTreasury] = deriveTreasuryPDA(vault, baseMint);

  // Determine token programs
  const baseMintAccount = await banksClient.getAccount(baseMint);
  const quoteMintAccount = await banksClient.getAccount(quoteMint);

  const quoteTokenProgram = quoteMintAccount?.owner || TOKEN_PROGRAM_ID;
  const baseTokenProgram = baseMintAccount?.owner || TOKEN_PROGRAM_ID;

  // Derive event authority PDA
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID
  );

  const transaction = await program.methods
    .addHonoraryLiquidity(liquidityDelta, SAFE_TOKEN_A_MAX, SAFE_TOKEN_B_MAX)
    .accountsPartial({
      funder: funder.publicKey,
      vault,
      positionOwner,
      position,
      pool,
      positionNftAccount,
      quoteMint,
      baseMint,
      quoteVault,
      baseVault,
      funderQuoteAccount,
      funderBaseAccount,
      quoteTreasury,
      baseTreasury,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      quoteTokenProgram,
      baseTokenProgram,
      eventAuthority,
    })
    .transaction();

  transaction.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
  transaction.sign(funder);

  await processTransactionMaybeThrow(banksClient, transaction);
}

/**
 * Parameters for crank distribution
 */
export interface CrankDistributionParams {
  cranker: Keypair;
  vault: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  baseMint: PublicKey;
  creatorQuoteATA: PublicKey;
  pageStart: number;
  pageSize: number;
  totalLockedAllInvestors: BN;
  investorAccounts: Array<{
    streamAccount: PublicKey;
    investorATA: PublicKey;
  }>;
}

/**
 * Execute crank distribution (permissionless)
 */
export async function crankDistribution(
  banksClient: BanksClient,
  params: CrankDistributionParams
): Promise<void> {
  const {
    cranker,
    vault,
    pool,
    quoteMint,
    baseMint,
    creatorQuoteATA,
    pageStart,
    pageSize,
    totalLockedAllInvestors,
    investorAccounts,
  } = params;

  const program = createFeeRouterProgram();

  // Derive PDAs
  const [positionOwner] = derivePositionOwnerPDA(vault);
  const [policy] = derivePolicyPDA(vault);
  const [progress] = deriveProgressPDA(vault);

  // Get position from position owner
  const positionOwnerAccount = await getInvestorFeePositionOwner(
    banksClient,
    positionOwner
  );
  const position = positionOwnerAccount.positionAccount;
  const positionNftMint = positionOwnerAccount.positionMint;

  // Derive position NFT account (CP-AMM PDA)
  // seeds = [POSITION_NFT_ACCOUNT_PREFIX, position_nft_mint.key()]
  const [positionNftAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_account", "utf8"), positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID
  );

  // Get pool authority
  const poolAuthority = derivePoolAuthority();

  // Derive treasury ATAs
  const [treasuryATA] = deriveTreasuryPDA(vault, quoteMint);
  const [baseTreasuryATA] = deriveTreasuryPDA(vault, baseMint);

  // Get pool state to read actual vault addresses
  const poolAccountInfo = await banksClient.getAccount(pool);
  if (!poolAccountInfo) {
    throw new Error(`Pool account not found: ${pool}`);
  }

  // Decode pool to get token_a_vault and token_b_vault
  // Pool struct (after 8-byte discriminator):
  // - pool_fees: 160 bytes (20 u64s)
  // - token_a_mint: 32 bytes (offset 168-200)
  // - token_b_mint: 32 bytes (offset 200-232)
  // - token_a_vault: 32 bytes (offset 232-264)
  // - token_b_vault: 32 bytes (offset 264-296)
  const poolData = Buffer.from(poolAccountInfo.data);
  const poolTokenAMint = new PublicKey(poolData.subarray(168, 200));
  const poolTokenBMint = new PublicKey(poolData.subarray(200, 232));
  const tokenAVault = new PublicKey(poolData.subarray(232, 264));
  const tokenBVault = new PublicKey(poolData.subarray(264, 296));

  // Determine which vault is quote and which is base
  // by comparing the pool's token mints with our quote/base mints

  const quoteVault = poolTokenBMint.equals(quoteMint)
    ? tokenBVault
    : tokenAVault;
  const baseVault = poolTokenAMint.equals(baseMint) ? tokenAVault : tokenBVault;

  // Determine token program by checking the vault owner
  // The pool vaults use the regular Token Program in this test setup
  const tokenProgram = TOKEN_PROGRAM_ID;

  // Event CPI accounts
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID
  );

  // Extract only the accounts for this page (per bounty spec line 28: pagination)
  // Each page should only include page_size investors, not all investors
  const startInvestorIdx = pageStart;
  const endInvestorIdx = Math.min(pageStart + pageSize, investorAccounts.length);
  const pageInvestorAccounts = investorAccounts.slice(startInvestorIdx, endInvestorIdx);

  // Determine if this is the final page
  const isFinalPage = endInvestorIdx >= investorAccounts.length;

  // Build remaining accounts for THIS PAGE only
  const remainingAccounts = pageInvestorAccounts.flatMap((inv) => [
    {
      pubkey: inv.streamAccount,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: inv.investorATA,
      isSigner: false,
      isWritable: true,
    },
  ]);

  // Add compute budget instruction for Streamflow SDK calculations
  // The SDK uses floating-point operations that exceed the default 200K limit
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });

  const transaction = await program.methods
    .crankDistribution(pageStart, pageSize, totalLockedAllInvestors, isFinalPage)
    .accountsPartial({
      cranker: cranker.publicKey,
      vault,
      positionOwner,
      position,
      pool,
      poolAuthority,
      quoteMint,
      baseMint,
      quoteVault,
      baseVault,
      treasuryAta: treasuryATA,
      baseTreasuryAta: baseTreasuryATA,
      creatorAta: creatorQuoteATA,
      positionNftAccount,
      eventAuthority,
      cpAmmProgramAccount: CP_AMM_PROGRAM_ID,
      policy,
      progress,
      streamflowProgram: STREAMFLOW_PROGRAM_ID,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      tokenProgram,
    })
    .remainingAccounts(remainingAccounts)
    .preInstructions([computeBudgetIx])
    .transaction();

  transaction.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
  transaction.sign(cranker);

  await processTransactionMaybeThrow(banksClient, transaction);
}

/**
 * Derive token vault address (CP-AMM standard)
 */
function deriveTokenVaultAddress(
  tokenMint: PublicKey,
  pool: PublicKey
): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), tokenMint.toBuffer(), pool.toBuffer()],
    CP_AMM_PROGRAM_ID
  );
  return vault;
}

/**
 * Get InvestorFeePositionOwner account state
 */
export async function getInvestorFeePositionOwner(
  banksClient: BanksClient,
  address: PublicKey
): Promise<InvestorFeePositionOwner> {
  const program = createFeeRouterProgram();
  const account = await banksClient.getAccount(address);
  if (!account) {
    throw new Error(`InvestorFeePositionOwner account not found: ${address}`);
  }
  return program.coder.accounts.decode(
    "investorFeePositionOwner",
    Buffer.from(account.data)
  );
}

/**
 * Get Policy account state
 */
export async function getPolicy(
  banksClient: BanksClient,
  address: PublicKey
): Promise<Policy> {
  const program = createFeeRouterProgram();
  const account = await banksClient.getAccount(address);
  if (!account) {
    throw new Error(`Policy account not found: ${address}`);
  }
  return program.coder.accounts.decode("policy", Buffer.from(account.data));
}

/**
 * Get DistributionProgress account state
 */
export async function getDistributionProgress(
  banksClient: BanksClient,
  address: PublicKey
): Promise<DistributionProgress> {
  const program = createFeeRouterProgram();
  const account = await banksClient.getAccount(address);
  if (!account) {
    throw new Error(`DistributionProgress account not found: ${address}`);
  }
  return program.coder.accounts.decode(
    "distributionProgress",
    Buffer.from(account.data)
  );
}

/**
 * Helper to create a quote-only pool for testing
 */
export interface CreateQuoteOnlyPoolParams {
  admin: Keypair;
  creator: Keypair;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  liquidity: BN;
  sqrtPrice: BN;
  collectFeeMode: number; // 1 = OnlyTokenA, 2 = OnlyTokenB
}

/**
 * Get token balance from an account
 */
export async function getTokenBalance(
  banksClient: BanksClient,
  tokenAccount: PublicKey
): Promise<BN> {
  const account = await banksClient.getAccount(tokenAccount);
  if (!account) {
    return new BN(0);
  }

  // Parse token account data (amount is at offset 64)
  const data = Buffer.from(account.data);
  const amount = data.readBigUInt64LE(64);
  return new BN(amount.toString());
}

/**
 * Helper to advance time in tests
 */
export async function advanceTime(
  banksClient: BanksClient,
  seconds: number
): Promise<void> {
  // Note: In bankrun, time advancement is handled differently
  // This is a placeholder - actual implementation depends on bankrun API
  // For now, we'll just wait
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
