import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL, Transaction, TransactionInstruction } from "@solana/web3.js";
import { BanksClient } from "solana-bankrun";
import BN from "bn.js";
import { processTransactionMaybeThrow } from "./common";
import { getOrCreateAssociatedTokenAccount } from "./token";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Streamflow program ID (mainnet)
 */
export const STREAMFLOW_PROGRAM_ID = new PublicKey(
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"
);

/**
 * Streamflow constants from SDK
 */
export const STREAMFLOW_TREASURY = new PublicKey("5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw");
export const STREAMFLOW_WITHDRAWOR = new PublicKey("wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u");
export const STREAMFLOW_FEE_ORACLE = new PublicKey("B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT");
export const METADATA_LEN = 1104;

/**
 * Create a mock Streamflow stream account for testing
 * This creates an account with the proper discriminator and structure
 * that can be read by the Streamflow SDK
 */
export async function createMockStreamflowStream(
  banksClient: BanksClient,
  payer: Keypair,
  context: any, // ProgramTestContext
  params: {
    sender: PublicKey;
    recipient: PublicKey;
    mint: PublicKey;
    depositedAmount: BN;
    startTime: BN;
    endTime: BN;
    cliffAmount?: BN;
    withdrawnAmount?: BN;
    amountPerPeriod?: BN;
    period?: BN;
  }
): Promise<PublicKey> {
  const streamKeypair = Keypair.generate();
  const {
    sender,
    recipient,
    mint,
    depositedAmount,
    startTime,
    endTime,
    cliffAmount = new BN(0),
    withdrawnAmount = new BN(0),
    amountPerPeriod = new BN(0),
    period = new BN(1),
  } = params;

  // Streamflow stream account structure
  // This is a simplified version for testing - real Streamflow accounts have more fields
  const streamData: MockStreamflowStream = {
    magic: new BN(0x5354524541_4d), // "STREAM" in hex
    version: new BN(1),
    createdAt: new BN(Math.floor(Date.now() / 1000)),
    withdrawnAt: new BN(0),
    startTime,
    endTime,
    depositedAmount,
    withdrawnAmount,
    sender,
    recipient,
    mint,
    escrowTokens: Keypair.generate().publicKey, // Mock escrow
    partner: PublicKey.default,
    canCancel: true,
    canTransfer: false,
    cliffAmount,
    amountPerPeriod,
    period,
    cancelled: false,
    withdrawalFrequency: new BN(1),
  };

  // Serialize the stream data
  const serializedData = serializeStreamflowStream(streamData);

  // Set the account directly in the bankrun context with data
  // Using a fixed rent amount (typically ~3000 lamports per 256 bytes)
  const rent = BigInt(10000000); // 0.01 SOL, enough for any account
  await context.setAccount(streamKeypair.publicKey, {
    executable: false,
    owner: STREAMFLOW_PROGRAM_ID,
    lamports: rent,
    data: serializedData,
  });

  return streamKeypair.publicKey;
}

/**
 * Serialize a mock Streamflow stream to bytes
 * This matches the on-chain layout that the Streamflow SDK expects
 * Based on streamflow_sdk::state::Contract struct (NO discriminator!)
 */
function serializeStreamflowStream(stream: MockStreamflowStream): Buffer {
  const buffers: Buffer[] = [];

  // NO DISCRIMINATOR for Streamflow Contract!

  // Magic number (8 bytes - u64)
  buffers.push(stream.magic.toBuffer("le", 8));

  // Version (1 byte - u8)
  buffers.push(Buffer.from([stream.version.toNumber()]));

  // created_at (8 bytes - u64)
  buffers.push(stream.createdAt.toBuffer("le", 8));

  // amount_withdrawn (8 bytes - u64)
  buffers.push(stream.withdrawnAmount.toBuffer("le", 8));

  // canceled_at (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // end_time (8 bytes - u64)
  buffers.push(stream.endTime.toBuffer("le", 8));

  // last_withdrawn_at (8 bytes - u64)
  buffers.push(stream.withdrawnAt.toBuffer("le", 8));

  // sender (32 bytes - Pubkey)
  buffers.push(stream.sender.toBuffer());

  // sender_tokens (32 bytes - Pubkey)
  buffers.push(PublicKey.default.toBuffer());

  // recipient (32 bytes - Pubkey)
  buffers.push(stream.recipient.toBuffer());

  // recipient_tokens (32 bytes - Pubkey)
  buffers.push(PublicKey.default.toBuffer());

  // mint (32 bytes - Pubkey)
  buffers.push(stream.mint.toBuffer());

  // escrow_tokens (32 bytes - Pubkey)
  buffers.push(stream.escrowTokens.toBuffer());

  // streamflow_treasury (32 bytes - Pubkey)
  buffers.push(PublicKey.default.toBuffer());

  // streamflow_treasury_tokens (32 bytes - Pubkey)
  buffers.push(PublicKey.default.toBuffer());

  // streamflow_fee_total (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // streamflow_fee_withdrawn (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // streamflow_fee_percent (4 bytes - f32)
  buffers.push(Buffer.from([0, 0, 0, 0]));

  // partner (32 bytes - Pubkey)
  buffers.push(stream.partner.toBuffer());

  // partner_tokens (32 bytes - Pubkey)
  buffers.push(PublicKey.default.toBuffer());

  // partner_fee_total (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // partner_fee_withdrawn (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // partner_fee_percent (4 bytes - f32)
  buffers.push(Buffer.from([0, 0, 0, 0]));

  // ix: CreateParams struct
  // start_time (8 bytes - u64)
  buffers.push(stream.startTime.toBuffer("le", 8));

  // net_amount_deposited (8 bytes - u64)
  buffers.push(stream.depositedAmount.toBuffer("le", 8));

  // period (8 bytes - u64)
  buffers.push(stream.period.toBuffer("le", 8));

  // amount_per_period (8 bytes - u64)
  buffers.push(stream.amountPerPeriod.toBuffer("le", 8));

  // cliff (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // cliff_amount (8 bytes - u64)
  buffers.push(stream.cliffAmount.toBuffer("le", 8));

  // cancelable_by_sender (1 byte - bool)
  buffers.push(Buffer.from([stream.canCancel ? 1 : 0]));

  // cancelable_by_recipient (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // automatic_withdrawal (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // transferable_by_sender (1 byte - bool)
  buffers.push(Buffer.from([stream.canTransfer ? 1 : 0]));

  // transferable_by_recipient (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // can_topup (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // stream_name (64 bytes - [u8; 64])
  const nameBuffer = Buffer.alloc(64);
  nameBuffer.write("Test Stream", 0);
  buffers.push(nameBuffer);

  // withdraw_frequency (8 bytes - u64)
  buffers.push(stream.withdrawalFrequency.toBuffer("le", 8));

  // ghost (4 bytes - u32)
  buffers.push(Buffer.from([0, 0, 0, 0]));

  // pausable (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // can_update_rate (1 byte - bool)
  buffers.push(Buffer.from([0]));

  // ix_padding (Vec<u8>) - borsh encodes as u32 length + data
  // Padding to make total struct size = 1104 bytes (METADATA_LEN)
  // Current size before padding: 578 bytes
  // Need: 1104 - 578 = 526 bytes of padding
  // But Vec encodes as: u32 length + data, so we need 522 bytes data + 4 bytes length = 526
  const paddingSize = 522;
  const paddingLengthBuffer = Buffer.alloc(4);
  paddingLengthBuffer.writeUInt32LE(paddingSize, 0);
  buffers.push(paddingLengthBuffer);
  buffers.push(Buffer.alloc(paddingSize)); // 522 bytes of zeros

  // closed (1 byte - bool)
  buffers.push(Buffer.from([stream.cancelled ? 1 : 0]));

  // current_pause_start (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // pause_cumulative (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // last_rate_change_time (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  // funds_unlocked_at_last_rate_change (8 bytes - u64)
  buffers.push(new BN(0).toBuffer("le", 8));

  return Buffer.concat(buffers);
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
 * Create multiple mock investor streams for testing
 * Returns array of stream pubkeys and their corresponding locked amounts
 */
export async function createMockInvestorStreams(
  banksClient: BanksClient,
  payer: Keypair,
  context: any, // ProgramTestContext
  params: {
    investorCount: number;
    sender: PublicKey;
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

  const currentTime = new BN(Math.floor(Date.now() / 1000));

  for (let i = 0; i < investorCount; i++) {
    const recipient = Keypair.generate().publicKey;
    recipients.push(recipient);

    // Calculate deposited amount and vesting schedule
    const lockedPercent = lockedPercentages[i];
    const depositedAmount = perInvestorAllocation;

    // For a linear vesting stream with X% locked:
    // We need to position ourselves in the vesting timeline such that X% is still locked
    // locked% = (total - vested) / total
    // So if 50% locked, we're 50% through the vesting period

    // Calculate vesting timeline
    const totalDuration = vestingEndTime.sub(vestingStartTime);
    const vestedPercent = 100 - lockedPercent;

    // Adjust current time or use end_time to control vesting
    // For simplicity: if 0% locked (100% vested), set end_time = now
    // if 100% locked (0% vested), set end_time far in future
    let effectiveEndTime: BN;
    if (lockedPercent === 0) {
      // Fully vested - set end_time to now or past
      effectiveEndTime = currentTime;
    } else if (lockedPercent === 100) {
      // Not vested at all - use original end time
      effectiveEndTime = vestingEndTime;
    } else {
      // Partially vested - calculate end time such that X% is locked
      // current_time should be (100 - locked%) through the vesting
      // end_time = start_time + (current_time - start_time) / vested% * 100%
      const elapsed = currentTime.sub(vestingStartTime);
      const totalNeeded = elapsed.mul(new BN(100)).div(new BN(vestedPercent));
      effectiveEndTime = vestingStartTime.add(totalNeeded);
    }

    // amount_per_period for linear vesting over 1-second periods
    const period = new BN(1);
    const duration = effectiveEndTime.sub(vestingStartTime).toNumber();
    const amountPerPeriod = duration > 0 ? depositedAmount.div(new BN(duration)) : depositedAmount;

    // No withdrawals yet - all vested tokens are still available to claim
    const withdrawnAmount = new BN(0);

    const streamPubkey = await createMockStreamflowStream(
      banksClient,
      payer,
      context,
      {
        sender,
        recipient,
        mint,
        depositedAmount,
        startTime: vestingStartTime,
        endTime: effectiveEndTime,
        withdrawnAmount,
        amountPerPeriod,
        period,
      }
    );

    streams.push(streamPubkey);

    // Calculate actual locked amount using Streamflow logic
    // locked = deposited - available_to_claim
    const availableToWithdraw = Math.min(
      depositedAmount.toNumber(),
      Math.max(0, depositedAmount.toNumber() * vestedPercent / 100)
    );
    const locked = depositedAmount.toNumber() - availableToWithdraw;
    lockedAmounts.push(new BN(locked));

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
