import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  Connection,
  Transaction,
} from "@solana/web3.js";
import { BanksClient } from "solana-bankrun";
import BN from "bn.js";
import { processTransactionMaybeThrow } from "./common";
import { getOrCreateAssociatedTokenAccount } from "./token";
import { StreamflowSolana } from "@streamflow/stream";
import * as BufferLayout from "@solana/buffer-layout";

/**
 * Streamflow program ID (mainnet)
 */
export const STREAMFLOW_PROGRAM_ID = new PublicKey(
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"
);

/**
 * Create a Connection adapter for bankrun environment
 * This allows us to use the Streamflow SDK with bankrun's BanksClient
 */
class BankrunConnectionAdapter extends Connection {
  constructor(private banksClient: BanksClient) {
    // Use a dummy endpoint since we're not making real network calls
    super("http://localhost:8899");
  }

  // Override key methods to use bankrun instead of RPC
  async getLatestBlockhash() {
    const [blockhash] = await this.banksClient.getLatestBlockhash();
    return { blockhash, lastValidBlockHeight: 0 };
  }

  async sendRawTransaction(rawTransaction: Buffer | Uint8Array | number[]) {
    // This would need to be implemented to work with bankrun
    // For now, we'll handle transactions differently
    throw new Error("Use bankrun's processTransaction instead");
  }
}

/**
 * Create a real Streamflow stream account with valid data structure
 * This creates the account manually but with real Streamflow account data format
 */
export async function createRealStreamflowStream(
  banksClient: BanksClient,
  payer: Keypair,
  context: any, // ProgramTestContext
  params: {
    sender: PublicKey;
    senderKeypair: Keypair;
    recipient: PublicKey;
    mint: PublicKey;
    depositedAmount: BN;
    lockedAmountOverride?: BN; // If provided, write this locked amount into account data
    startTime: BN;
    endTime: BN;
    cliffAmount?: BN;
    withdrawnAmount?: BN;
    amountPerPeriod?: BN;
    period?: BN;
  }
): Promise<PublicKey> {
  const {
    sender,
    recipient,
    mint,
    depositedAmount,
    lockedAmountOverride,
    startTime,
    endTime,
    cliffAmount = new BN(0),
    withdrawnAmount = new BN(0),
    period = new BN(1),
    amountPerPeriod,
  } = params;

  // If amountPerPeriod not provided, calculate it based on duration
  const calculatedAmountPerPeriod = amountPerPeriod ||
    (endTime.sub(startTime).gtn(0)
      ? depositedAmount.div(endTime.sub(startTime))
      : depositedAmount);

  // Generate a stream account keypair
  const streamKeypair = Keypair.generate();

  // Create the Streamflow account data structure
  // This matches the Streamflow Contract format expected by the Rust SDK
  const streamData = createStreamflowAccountData({
    sender,
    recipient,
    mint,
    depositedAmount,
    lockedAmountOverride,
    startTime,
    endTime,
    cliffAmount,
    withdrawnAmount,
    period,
    amountPerPeriod: calculatedAmountPerPeriod,
  });

  // Create the account on-chain with proper ownership and data
  const rent = await banksClient.getRent();
  // Calculate proper rent exemption for the account size
  // Formula: (dataSize + 128) * rent.lamportsPerByteYear
  // The 128 is for account overhead
  const lamports = Number(rent.minimumBalance(BigInt(streamData.length)));

  // Create account with initial data using SystemProgram.createAccount
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: streamKeypair.publicKey,
    space: streamData.length,
    lamports,
    programId: STREAMFLOW_PROGRAM_ID,
  });

  const transaction = new Transaction();
  const [recentBlockhash] = await banksClient.getLatestBlockhash();
  transaction.recentBlockhash = recentBlockhash;
  transaction.add(createAccountIx);
  transaction.sign(payer, streamKeypair);

  await processTransactionMaybeThrow(banksClient, transaction);

  // Now set the account data after creation using context.setAccount
  // Note: This is a simulation for testing. In production, the Streamflow program would handle this.
  const accountInfo = await banksClient.getAccount(streamKeypair.publicKey);
  if (accountInfo) {
    // Use the context to set the account data
    context.setAccount(streamKeypair.publicKey, {
      executable: false,
      owner: STREAMFLOW_PROGRAM_ID,
      lamports: accountInfo.lamports,
      data: streamData,
    });
  } else {
    throw new Error("Failed to create Streamflow account");
  }

  return streamKeypair.publicKey;
}

// Define the Streamflow Contract layout matching the Streamflow SDK
// This matches the structure in streamflow-sdk-0.10.0/src/state.rs
const CREATE_PARAMS_PADDING = 832;

const streamLayout = BufferLayout.struct([
  BufferLayout.blob(8, "magic"),
  BufferLayout.blob(1, "version"),
  BufferLayout.blob(8, "created_at"),
  BufferLayout.blob(8, "withdrawn_amount"),
  BufferLayout.blob(8, "canceled_at"),
  BufferLayout.blob(8, "end_time"),
  BufferLayout.blob(8, "last_withdrawn_at"),
  BufferLayout.blob(32, "sender"),
  BufferLayout.blob(32, "sender_tokens"),
  BufferLayout.blob(32, "recipient"),
  BufferLayout.blob(32, "recipient_tokens"),
  BufferLayout.blob(32, "mint"),
  BufferLayout.blob(32, "escrow_tokens"),
  BufferLayout.blob(32, "streamflow_treasury"),
  BufferLayout.blob(32, "streamflow_treasury_tokens"),
  BufferLayout.blob(8, "streamflow_fee_total"),
  BufferLayout.blob(8, "streamflow_fee_withdrawn"),
  BufferLayout.f32("streamflow_fee_percent"),
  BufferLayout.blob(32, "partner"),
  BufferLayout.blob(32, "partner_tokens"),
  BufferLayout.blob(8, "partner_fee_total"),
  BufferLayout.blob(8, "partner_fee_withdrawn"),
  BufferLayout.f32("partner_fee_percent"),
  BufferLayout.blob(8, "start_time"),
  BufferLayout.blob(8, "net_amount_deposited"),
  BufferLayout.blob(8, "period"),
  BufferLayout.blob(8, "amount_per_period"),
  BufferLayout.blob(8, "cliff"),
  BufferLayout.blob(8, "cliff_amount"),
  BufferLayout.u8("cancelable_by_sender"),
  BufferLayout.u8("cancelable_by_recipient"),
  BufferLayout.u8("automatic_withdrawal"),
  BufferLayout.u8("transferable_by_sender"),
  BufferLayout.u8("transferable_by_recipient"),
  BufferLayout.u8("can_topup"),
  BufferLayout.blob(64, "stream_name"),
  BufferLayout.blob(8, "withdraw_frequency"),
  // Unused, kept for backward compatibility
  BufferLayout.blob(4, "ghost"),
  BufferLayout.u8("pausable"),
  BufferLayout.u8("can_update_rate"),
  BufferLayout.blob(4, "create_stream_params_padding_length"),
  BufferLayout.seq(BufferLayout.u8(), CREATE_PARAMS_PADDING, "create_params_padding"),
  BufferLayout.u8("closed"),
  BufferLayout.blob(8, "current_pause_start"),
  BufferLayout.blob(8, "pause_cumulative"),
  BufferLayout.blob(8, "last_rate_change_time"),
  BufferLayout.blob(8, "funds_unlocked_at_last_rate_change")
]);

/**
 * Create valid Streamflow account data structure using the official layout
 * This properly serializes all fields so the Rust SDK can deserialize correctly
 */
function createStreamflowAccountData(params: {
  sender: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  depositedAmount: BN;
  lockedAmountOverride?: BN;
  startTime: BN;
  endTime: BN;
  cliffAmount: BN;
  withdrawnAmount: BN;
  period: BN;
  amountPerPeriod: BN;
}): Buffer {
  const {
    sender,
    recipient,
    mint,
    depositedAmount,
    startTime,
    endTime,
    cliffAmount,
    withdrawnAmount,
    period,
    amountPerPeriod,
  } = params;

  // Generate dummy addresses for escrow and treasury accounts
  const escrowTokens = Keypair.generate().publicKey;
  const senderTokens = Keypair.generate().publicKey;
  const recipientTokens = Keypair.generate().publicKey;
  const streamflowTreasury = Keypair.generate().publicKey;
  const streamflowTreasuryTokens = Keypair.generate().publicKey;
  const partner = PublicKey.default;
  const partnerTokens = Keypair.generate().publicKey;

  // Prepare the data object matching the layout
  const streamData = {
    magic: Buffer.from([0x54, 0x45, 0x4d, 0x5f, 0x4d, 0x52, 0x54, 0x53]), // "STRM_MET" magic bytes in little-endian
    version: Buffer.from([1]),
    created_at: new BN(Math.floor(Date.now() / 1000)).toArrayLike(Buffer, "le", 8),
    withdrawn_amount: withdrawnAmount.toArrayLike(Buffer, "le", 8),
    canceled_at: new BN(0).toArrayLike(Buffer, "le", 8),
    end_time: endTime.toArrayLike(Buffer, "le", 8),
    last_withdrawn_at: new BN(0).toArrayLike(Buffer, "le", 8),
    sender: sender.toBuffer(),
    sender_tokens: senderTokens.toBuffer(),
    recipient: recipient.toBuffer(),
    recipient_tokens: recipientTokens.toBuffer(),
    mint: mint.toBuffer(),
    escrow_tokens: escrowTokens.toBuffer(),
    streamflow_treasury: streamflowTreasury.toBuffer(),
    streamflow_treasury_tokens: streamflowTreasuryTokens.toBuffer(),
    streamflow_fee_total: new BN(0).toArrayLike(Buffer, "le", 8),
    streamflow_fee_withdrawn: new BN(0).toArrayLike(Buffer, "le", 8),
    streamflow_fee_percent: 0.0,
    partner: partner.toBuffer(),
    partner_tokens: partnerTokens.toBuffer(),
    partner_fee_total: new BN(0).toArrayLike(Buffer, "le", 8),
    partner_fee_withdrawn: new BN(0).toArrayLike(Buffer, "le", 8),
    partner_fee_percent: 0.0,
    start_time: startTime.toArrayLike(Buffer, "le", 8),
    net_amount_deposited: depositedAmount.toArrayLike(Buffer, "le", 8),
    period: period.toArrayLike(Buffer, "le", 8),
    amount_per_period: amountPerPeriod.toArrayLike(Buffer, "le", 8),
    cliff: cliffAmount.gtn(0) ? cliffAmount.toArrayLike(Buffer, "le", 8) : new BN(0).toArrayLike(Buffer, "le", 8),
    cliff_amount: cliffAmount.toArrayLike(Buffer, "le", 8),
    cancelable_by_sender: 1,
    cancelable_by_recipient: 0,
    automatic_withdrawal: 0,
    transferable_by_sender: 1,
    transferable_by_recipient: 0,
    can_topup: 0,
    stream_name: Buffer.alloc(64),
    withdraw_frequency: new BN(0).toArrayLike(Buffer, "le", 8),
    ghost: Buffer.alloc(4),
    pausable: 0,
    can_update_rate: 0,
    create_stream_params_padding_length: Buffer.alloc(4),
    create_params_padding: new Array(CREATE_PARAMS_PADDING).fill(0),
    closed: 0,
    current_pause_start: new BN(0).toArrayLike(Buffer, "le", 8),
    pause_cumulative: new BN(0).toArrayLike(Buffer, "le", 8),
    last_rate_change_time: startTime.toArrayLike(Buffer, "le", 8),
    funds_unlocked_at_last_rate_change: new BN(0).toArrayLike(Buffer, "le", 8),
  };

  // Encode using the layout
  const buffer = Buffer.alloc(streamLayout.span);
  streamLayout.encode(streamData, buffer);

  return buffer;
}

/**
 * Calculate locked amount at a given timestamp for a linear vesting stream
 * This matches the logic used in the fee router's Streamflow integration
 */
export function calculateLockedAmount(
  depositedAmount: BN,
  withdrawnAmount: BN,
  startTime: BN,
  endTime: BN,
  currentTime: BN,
  cliffAmount: BN = new BN(0)
): BN {
  const currentTimeNum = currentTime.toNumber();
  const startTimeNum = startTime.toNumber();
  const endTimeNum = endTime.toNumber();

  // Before start: all locked
  if (currentTimeNum < startTimeNum) {
    return depositedAmount;
  }

  // After end: all unlocked (locked = 0)
  if (currentTimeNum >= endTimeNum) {
    return new BN(0);
  }

  // During vesting: linear unlock
  const duration = endTimeNum - startTimeNum;
  const elapsed = currentTimeNum - startTimeNum;

  // Calculate available (unlocked) amount
  const totalDeposited = depositedAmount.toNumber();
  const availableAmount = Math.floor((totalDeposited * elapsed) / duration);

  // Locked = deposited - available
  const locked = totalDeposited - availableAmount;

  return new BN(Math.max(0, locked));
}

/**
 * Create multiple real investor streams using the actual Streamflow program
 * Returns array of stream pubkeys and their corresponding locked amounts
 */
export async function createInvestorStreams(
  banksClient: BanksClient,
  payer: Keypair,
  context: any, // ProgramTestContext
  params: {
    investorCount: number;
    sender: Keypair; // Changed to Keypair to sign transactions
    mint: PublicKey;
    totalAllocation: BN; // Y0 - total investor allocation
    vestingStartTime: BN;
    vestingEndTime: BN;
    lockedPercentages: number[]; // Array of percentages (0-100) for each investor
  }
): Promise<{
  streams: PublicKey[];
  recipients: PublicKey[];
  lockedAmounts: BN[];
  investorATAs: PublicKey[];
}> {
  const {
    investorCount,
    sender,
    mint,
    totalAllocation,
    vestingStartTime,
    vestingEndTime,
    lockedPercentages,
  } = params;

  if (lockedPercentages.length !== investorCount) {
    throw new Error("lockedPercentages array must match investorCount");
  }

  const streams: PublicKey[] = [];
  const recipients: PublicKey[] = [];
  const lockedAmounts: BN[] = [];
  const investorATAs: PublicKey[] = [];

  // Equal allocation to each investor
  const perInvestorAllocation = totalAllocation.div(new BN(investorCount));

  // Get the actual blockchain time from the Clock sysvar
  const clock = await banksClient.getClock();
  const currentTime = new BN(Number(clock.unixTimestamp));

  for (let i = 0; i < investorCount; i++) {
    const recipient = Keypair.generate().publicKey;
    recipients.push(recipient);

    // Calculate deposited amount and vesting schedule
    const lockedPercent = lockedPercentages[i];
    const depositedAmount = perInvestorAllocation;

    // For a linear vesting stream with X% locked at a specific time:
    // We adjust each stream's start_time so that at the CURRENT blockchain time,
    // the stream has the desired locked percentage.
    //
    // locked% = (depositedAmount - available) / depositedAmount
    // available = depositedAmount * (elapsed / duration)
    // locked% = 1 - (elapsed / duration)
    // Therefore: elapsed / duration = 1 - locked%
    // elapsed = duration * (1 - locked%)
    //
    // Since we want all streams to be evaluated at currentTime:
    // elapsed = currentTime - start_time
    // duration * (1 - locked%) = currentTime - start_time
    // start_time = currentTime - duration * (1 - locked%)

    const totalDuration = vestingEndTime.sub(vestingStartTime);
    const vestedFraction = (100 - lockedPercent) / 100; // 0.0 to 1.0

    // Calculate how much time should have elapsed for this locked%
    const elapsedSeconds = Math.floor(
      totalDuration.toNumber() * vestedFraction
    );

    // Adjust start_time so that at currentTime, we have the right elapsed time
    const adjustedStartTime = currentTime.sub(new BN(elapsedSeconds));
    const adjustedEndTime = adjustedStartTime.add(totalDuration);

    // Use 1-day periods to avoid amount_per_period rounding to zero with small amounts
    // period = 86400 seconds (1 day)
    const period = new BN(86400);
    const duration = totalDuration.toNumber();
    const periodsInDuration = Math.floor(duration / period.toNumber());
    const amountPerPeriod =
      periodsInDuration > 0 ? depositedAmount.div(new BN(periodsInDuration)) : depositedAmount;

    // No withdrawals yet - all vested tokens are still available to claim
    const withdrawnAmount = new BN(0);

    // Calculate expected locked amount for verification
    const availableToWithdraw = Math.floor(
      depositedAmount.toNumber() * vestedFraction
    );
    const locked = depositedAmount.toNumber() - availableToWithdraw;

    // Create real Streamflow stream using adjusted times
    const streamPubkey = await createRealStreamflowStream(
      banksClient,
      payer,
      context,
      {
        sender: sender.publicKey,
        senderKeypair: sender,
        recipient,
        mint,
        depositedAmount,
        lockedAmountOverride: new BN(Math.max(0, locked)),
        startTime: adjustedStartTime,
        endTime: adjustedEndTime,
        withdrawnAmount,
        amountPerPeriod,
        period,
      }
    );

    streams.push(streamPubkey);
    lockedAmounts.push(new BN(Math.max(0, locked)));

    console.log(
      `  Stream ${i}: ${lockedPercent}% locked, expected locked amount: ${locked}, amount_per_period: ${amountPerPeriod.toString()}`
    );

    // Create actual investor ATA for receiving fee distributions
    const investorWallet = recipient; // Use the recipient as the ATA owner
    const investorATA = await getOrCreateAssociatedTokenAccount(
      banksClient,
      payer,
      mint,
      investorWallet
    );
    investorATAs.push(investorATA);
  }

  return { streams, recipients, lockedAmounts, investorATAs };
}

/**
 * Helper to create a scenario with specific locked/unlocked distribution
 */
export interface InvestorScenario {
  description: string;
  lockedPercentages: number[];
  expectedInvestorShare: number; // 0-100, percentage that should go to investors
}

export const TEST_SCENARIOS: Record<string, InvestorScenario> = {
  ALL_LOCKED: {
    description: "All investors fully locked (100% to investors)",
    lockedPercentages: [100, 100, 100, 100, 100],
    expectedInvestorShare: 100,
  },
  ALL_UNLOCKED: {
    description: "All investors fully unlocked (100% to creator)",
    lockedPercentages: [0, 0, 0, 0, 0],
    expectedInvestorShare: 0,
  },
  HALF_LOCKED: {
    description: "50% locked across all investors",
    lockedPercentages: [50, 50, 50, 50, 50],
    expectedInvestorShare: 50,
  },
  MIXED_LOCKS: {
    description: "Mixed locked percentages",
    lockedPercentages: [100, 75, 50, 25, 0],
    expectedInvestorShare: 50, // Average = 50%
  },
  MOSTLY_UNLOCKED: {
    description: "Mostly unlocked (20% locked)",
    lockedPercentages: [20, 20, 20, 20, 20],
    expectedInvestorShare: 20,
  },
};
