import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BanksClient, ProgramTestContext, startAnchor } from "solana-bankrun";
import { ALPHA_VAULT_PROGRAM_ID, CP_AMM_PROGRAM_ID } from "./constants";
import BN from "bn.js";
import { TRANSFER_HOOK_COUNTER_PROGRAM_ID } from "./transferHook";

import CpAmmIdl from "../../target/idl/cp_amm.json";

const FEE_ROUTER_PROGRAM_ID = new PublicKey("5B57SJ3g2YoNXUpsZqqjEQkRSxyKtVTQRXdgAirz6bio");
const STREAMFLOW_PROGRAM_ID = new PublicKey("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m");

export async function startTest(root: Keypair) {
  // Program name need to match fixtures program name
  return startAnchor(
    "./",
    [
      {
        name: "cp_amm",
        programId: new PublicKey(CP_AMM_PROGRAM_ID),
      },
      {
        name: "fee_router",
        programId: FEE_ROUTER_PROGRAM_ID,
      },
      {
        name: "transfer_hook_counter",
        programId: TRANSFER_HOOK_COUNTER_PROGRAM_ID,
      },
      {
        name: "alpha_vault",
        programId: new PublicKey(ALPHA_VAULT_PROGRAM_ID),
      },
      {
        name: "streamflow",
        programId: STREAMFLOW_PROGRAM_ID,
      },
    ],
    [
      {
        address: root.publicKey,
        info: {
          executable: false,
          owner: SystemProgram.programId,
          lamports: LAMPORTS_PER_SOL * 100,
          data: new Uint8Array(),
        },
      },
    ]
  );
}

export async function transferSol(
  banksClient: BanksClient,
  from: Keypair,
  to: PublicKey,
  amount: BN
) {
  const systemTransferIx = SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports: BigInt(amount.toString()),
  });

  let transaction = new Transaction();
  const [recentBlockhash] = await banksClient.getLatestBlockhash();
  transaction.recentBlockhash = recentBlockhash;
  transaction.add(systemTransferIx);
  transaction.sign(from);

  await banksClient.processTransaction(transaction);
}

export async function processTransactionMaybeThrow(
  banksClient: BanksClient,
  transaction: Transaction
) {
  const transactionMeta = await banksClient.tryProcessTransaction(transaction);
  if (transactionMeta.result && transactionMeta.result.length > 0) {
    // Parse error code if present
    let errorMessage = transactionMeta.result;

    // Check for custom program error codes (e.g., "custom program error: 0x2ee0")
    const match = errorMessage.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (match) {
      const errorCode = parseInt(match[1], 16);
      // Fee router errors: Anchor adds 6000 offset, so error codes become:
      // QuoteOnlyValidationFailed = 6000 → 0x2ee0 = 12000
      // InvalidPoolConfiguration = 6006 → 0x2ee6 = 12006
      // To get the error name, we map errorCode directly to the enum value
      const errorCodeToName: Record<number, string> = {
        12000: "QuoteOnlyValidationFailed",
        12001: "BaseFeesDetected",
        12002: "CrankWindowNotReached",
        12003: "InvalidPagination",
        12004: "InsufficientStreamflowData",
        12005: "DistributionAlreadyComplete",
        12006: "InvalidPoolConfiguration",
        12007: "MathOverflow",
        12008: "AccountCountMismatch",
        12009: "DailyCapExceeded",
        12010: "InvalidPositionOwnership",
      };

      if (errorCode in errorCodeToName) {
        errorMessage += ` (${errorCodeToName[errorCode]})`;
      }
    }

    throw Error(errorMessage);
  }
}

export async function expectThrowsAsync(
  fn: () => Promise<void>,
  errorMessage: String
) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    } else {
      if (!err.message.toLowerCase().includes(errorMessage.toLowerCase())) {
        throw new Error(
          `Unexpected error: ${err.message}. Expected error: ${errorMessage}`
        );
      }
      return;
    }
  }
  throw new Error("Expected an error but didn't get one");
}

export function getCpAmmProgramErrorCodeHexString(errorMessage: String) {
  const error = CpAmmIdl.errors.find(
    (e) =>
      e.name.toLowerCase() === errorMessage.toLowerCase() ||
      e.msg.toLowerCase() === errorMessage.toLowerCase()
  );

  if (!error) {
    throw new Error(
      `Unknown stake for fee error message / name: ${errorMessage}`
    );
  }

  return "0x" + error.code.toString(16);
}

export async function generateKpAndFund(
  banksClient: BanksClient,
  rootKeypair: Keypair
): Promise<Keypair> {
  const kp = Keypair.generate();
  await transferSol(
    banksClient,
    rootKeypair,
    kp.publicKey,
    new BN(100 * LAMPORTS_PER_SOL)
  );
  return kp;
}

export function randomID(min = 0, max = 10000) {
  return Math.floor(Math.random() * (max - min) + min);
}

export async function warpSlotBy(context: ProgramTestContext, slots: BN) {
  const clock = await context.banksClient.getClock();
  context.warpToSlot(clock.slot + BigInt(slots.toString()));
}

export function convertToByteArray(value: BN): number[] {
  return Array.from(value.toArrayLike(Buffer, "le", 8));
}

export function convertToRateLimiterSecondFactor(
  maxLimiterDuration: BN,
  maxFeeBps: BN
): number[] {
  const buffer1 = maxLimiterDuration.toArrayLike(Buffer, "le", 4);
  const buffer2 = maxFeeBps.toArrayLike(Buffer, "le", 4);
  const buffer = Buffer.concat([buffer1, buffer2]);
  return Array.from(buffer);
}
