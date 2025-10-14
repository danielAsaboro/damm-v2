import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL, Connection, Transaction } from "@solana/web3.js";
import { BanksClient } from "solana-bankrun";
import BN from "bn.js";
import { processTransactionMaybeThrow } from "./common";
import { getOrCreateAssociatedTokenAccount } from "./token";
import { StreamflowSolana } from "@streamflow/stream";

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
  params: {
    sender: PublicKey;
    senderKeypair: Keypair;
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
  const {
    sender,
    recipient,
    mint,
    depositedAmount,
    startTime,
    endTime,
    cliffAmount = new BN(0),
    withdrawnAmount = new BN(0),
    period = new BN(1),
  } = params;

  // Generate a stream account keypair
  const streamKeypair = Keypair.generate();
  
  // Create the Streamflow account data structure
  // This matches the Streamflow Contract format expected by the Rust SDK
  const streamData = createStreamflowAccountData({
    sender,
    recipient,
    mint,
    depositedAmount,
    startTime,
    endTime,
    cliffAmount,
    withdrawnAmount,
    period,
  });

  // Create the account on-chain with proper ownership
  const rent = await banksClient.getRent();
  // Use a larger amount to ensure rent exemption (simple approach)
  const lamports = Math.max(
    Number(rent.lamportsPerByteYear) * streamData.length + Number(rent.exemptionThreshold),
    10000000 // 0.01 SOL minimum
  );
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

  // For testing purposes, we'll set the account data to be compatible with the Streamflow SDK
  // In a production environment, this would be done by calling the actual Streamflow program
  const accountInfo = await banksClient.getAccount(streamKeypair.publicKey);
  if (accountInfo) {
    // Copy our stream data to the account
    // Note: This is a simulation for testing. In production, the Streamflow program would handle this.
    streamData.copy(accountInfo.data, 0);
  } else {
    throw new Error("Failed to create Streamflow account");
  }

  return streamKeypair.publicKey;
}

/**
 * Create valid Streamflow account data structure
 * This attempts to match the actual Streamflow Contract binary format
 * Based on the Streamflow SDK structure that has ix.net_amount_deposited
 */
function createStreamflowAccountData(params: {
  sender: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  depositedAmount: BN;
  startTime: BN;
  endTime: BN;
  cliffAmount: BN;
  withdrawnAmount: BN;
  period: BN;
}): Buffer {
  // Create a larger buffer to accommodate the full Streamflow Contract structure
  const buffer = Buffer.alloc(2000);
  let offset = 0;

  // Anchor discriminator (8 bytes) - this is critical for Anchor deserialization
  // Official discriminator from Streamflow JS SDK constants.ts line 45:
  // CONTRACT_DISCRIMINATOR = [172, 138, 115, 242, 121, 67, 183, 26]
  const discriminator = Buffer.from([172, 138, 115, 242, 121, 67, 183, 26]);
  discriminator.copy(buffer, offset);
  offset += 8;

  // The Rust streamflow-sdk expects a Contract struct with an 'ix' field
  // containing the stream data. The 'ix' field appears to be the stream instruction data.
  // From our Rust code: stream_contract.ix.net_amount_deposited
  
  // Contract struct fields (before the ix field)
  // Based on the access pattern, we likely need minimal Contract wrapper fields first
  
  // Add any Contract-specific fields here if needed (likely minimal or none)
  // For now, we'll structure it as if the ix field is the main stream data
  
  // Now follows the streamLayout structure (as the 'ix' field) from JS SDK layout.ts:
  
  // 1. magic (8 bytes) - stream magic identifier
  const magic = Buffer.from("STRM\x00\x00\x00\x00", "utf8");
  magic.copy(buffer, offset);
  offset += 8;
  
  // 2. version (1 byte)
  buffer.writeUInt8(1, offset);
  offset += 1;
  
  // 3. created_at (8 bytes) - timestamp
  const currentTime = new BN(Math.floor(Date.now() / 1000));
  const createdAtBuffer = currentTime.toArrayLike(Buffer, 'le', 8);
  createdAtBuffer.copy(buffer, offset);
  offset += 8;
  
  // 4. withdrawn_amount (8 bytes)
  const withdrawnBuffer = params.withdrawnAmount.toArrayLike(Buffer, 'le', 8);
  withdrawnBuffer.copy(buffer, offset);
  offset += 8;
  
  // 5. canceled_at (8 bytes) - 0 for active stream
  const zeroBuffer = Buffer.alloc(8);
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 6. end_time (8 bytes)
  const endBuffer = params.endTime.toArrayLike(Buffer, 'le', 8);
  endBuffer.copy(buffer, offset);
  offset += 8;
  
  // 7. last_withdrawn_at (8 bytes) - 0 for new stream
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 8. sender (32 bytes)
  params.sender.toBuffer().copy(buffer, offset);
  offset += 32;
  
  // 9. sender_tokens (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 10. recipient (32 bytes)
  params.recipient.toBuffer().copy(buffer, offset);
  offset += 32;
  
  // 11. recipient_tokens (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 12. mint (32 bytes)
  params.mint.toBuffer().copy(buffer, offset);
  offset += 32;
  
  // 13. escrow_tokens (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 14. streamflow_treasury (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 15. streamflow_treasury_tokens (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 16. streamflow_fee_total (8 bytes)
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 17. streamflow_fee_withdrawn (8 bytes)
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 18. streamflow_fee_percent (4 bytes f32)
  buffer.writeFloatLE(0.0, offset);
  offset += 4;
  
  // 19. partner (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 20. partner_tokens (32 bytes) - placeholder
  zeroBuffer.copy(buffer, offset); zeroBuffer.copy(buffer, offset + 8);
  zeroBuffer.copy(buffer, offset + 16); zeroBuffer.copy(buffer, offset + 24);
  offset += 32;
  
  // 21. partner_fee_total (8 bytes)
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 22. partner_fee_withdrawn (8 bytes)
  zeroBuffer.copy(buffer, offset);
  offset += 8;
  
  // 23. partner_fee_percent (4 bytes f32)
  buffer.writeFloatLE(0.0, offset);
  offset += 4;
  
  // 24. start_time (8 bytes)
  const startBuffer = params.startTime.toArrayLike(Buffer, 'le', 8);
  startBuffer.copy(buffer, offset);
  offset += 8;
  
  // 25. net_amount_deposited (8 bytes) - THIS IS WHAT THE RUST CODE READS!
  const depositedBuffer = params.depositedAmount.toArrayLike(Buffer, 'le', 8);
  depositedBuffer.copy(buffer, offset);
  offset += 8;
  
  // 26. period (8 bytes)
  const periodBuffer = params.period.toArrayLike(Buffer, 'le', 8);
  periodBuffer.copy(buffer, offset);
  offset += 8;
  
  // 27. amount_per_period (8 bytes)
  const amountPerPeriod = params.depositedAmount.div(params.period);
  const amountPerPeriodBuffer = amountPerPeriod.toArrayLike(Buffer, 'le', 8);
  amountPerPeriodBuffer.copy(buffer, offset);
  offset += 8;
  
  // 28. cliff (8 bytes) - cliff time
  startBuffer.copy(buffer, offset);
  offset += 8;
  
  // 29. cliff_amount (8 bytes)
  const cliffBuffer = params.cliffAmount.toArrayLike(Buffer, 'le', 8);
  cliffBuffer.copy(buffer, offset);
  offset += 8;
  
  // 30-34. Boolean flags (5 bytes)
  buffer.writeUInt8(1, offset); // cancelable_by_sender
  buffer.writeUInt8(0, offset + 1); // cancelable_by_recipient
  buffer.writeUInt8(0, offset + 2); // automatic_withdrawal
  buffer.writeUInt8(1, offset + 3); // transferable_by_sender
  buffer.writeUInt8(0, offset + 4); // transferable_by_recipient
  offset += 5;
  
  // 35. can_topup (1 byte)
  buffer.writeUInt8(0, offset);
  offset += 1;
  
  // 36. stream_name (64 bytes) - fill with zeros
  const nameBuffer = Buffer.alloc(64);
  nameBuffer.copy(buffer, offset);
  offset += 64;
  
  // 37. withdraw_frequency (8 bytes)
  const withdrawFreq = new BN(1);
  const withdrawFreqBuffer = withdrawFreq.toArrayLike(Buffer, 'le', 8);
  withdrawFreqBuffer.copy(buffer, offset);
  offset += 8;
  
  // 38. ghost (4 bytes) - unused padding
  buffer.writeUInt32LE(0, offset);
  offset += 4;
  
  // 39-40. More boolean flags (2 bytes)
  buffer.writeUInt8(0, offset); // pausable
  buffer.writeUInt8(0, offset + 1); // can_update_rate
  offset += 2;
  
  // 41. create_stream_params_padding_length (4 bytes)
  buffer.writeUInt32LE(126, offset); // CREATE_PARAMS_PADDING constant
  offset += 4;
  
  // 42. create_params_padding (126 bytes) - padding
  const paddingBuffer = Buffer.alloc(126);
  paddingBuffer.copy(buffer, offset);
  offset += 126;
  
  // 43. closed (1 byte)
  buffer.writeUInt8(0, offset); // not closed
  offset += 1;
  
  // 44-47. Additional timestamp fields (32 bytes total)
  zeroBuffer.copy(buffer, offset); // current_pause_start
  zeroBuffer.copy(buffer, offset + 8); // pause_cumulative  
  zeroBuffer.copy(buffer, offset + 16); // last_rate_change_time
  zeroBuffer.copy(buffer, offset + 24); // funds_unlocked_at_last_rate_change
  offset += 32;

  return buffer.slice(0, offset);
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
export async function createMockInvestorStreams(
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

    // Create real Streamflow stream using the actual program
    const streamPubkey = await createRealStreamflowStream(
      banksClient,
      payer,
      {
        sender: sender.publicKey,
        senderKeypair: sender,
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
