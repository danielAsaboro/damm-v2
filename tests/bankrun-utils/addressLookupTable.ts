import { ProgramTestContext } from "solana-bankrun";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

/**
 * Create a new Address Lookup Table (ALT) in bankrun environment
 *
 * @param context - ProgramTestContext from bankrun
 * @param authority - Authority keypair for the ALT
 * @param payer - Payer for rent
 * @returns Lookup table address
 */
export async function createAddressLookupTable(
  context: ProgramTestContext,
  authority: Keypair,
  payer: Keypair
): Promise<PublicKey> {
  const clock = await context.banksClient.getClock();
  // Use current slot minus 1 to ensure it's considered recent
  const recentSlot = clock.slot > BigInt(0) ? clock.slot - BigInt(1) : BigInt(0);

  const [createInstruction, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });

  const transaction = new Transaction().add(createInstruction);
  const [latestBlockhash] = await context.banksClient.getLatestBlockhash();
  transaction.recentBlockhash = latestBlockhash;
  transaction.feePayer = payer.publicKey;
  transaction.sign(payer, authority);

  const result = await context.banksClient.tryProcessTransaction(transaction);
  if (result.result) {
    throw new Error(`Failed to create lookup table: ${result.result}`);
  }

  return lookupTableAddress;
}

/**
 * Extend an Address Lookup Table with new addresses
 *
 * @param context - ProgramTestContext from bankrun
 * @param lookupTableAddress - Address of the lookup table to extend
 * @param authority - Authority keypair for the ALT
 * @param payer - Payer for rent
 * @param addresses - Array of addresses to add (max 256 total in table)
 */
export async function extendLookupTable(
  context: ProgramTestContext,
  lookupTableAddress: PublicKey,
  authority: Keypair,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<void> {
  // Split addresses into chunks of 30 (max per extend instruction)
  const chunkSize = 30;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);

    const extendInstruction = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lookupTableAddress,
      authority: authority.publicKey,
      payer: payer.publicKey,
      addresses: chunk,
    });

    const transaction = new Transaction().add(extendInstruction);
    const [latestBlockhash] = await context.banksClient.getLatestBlockhash();
    transaction.recentBlockhash = latestBlockhash;
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer, authority);

    const result = await context.banksClient.tryProcessTransaction(transaction);
    if (result.result) {
      throw new Error(`Failed to extend lookup table: ${result.result}`);
    }
  }
}

/**
 * Fetch an Address Lookup Table account from bankrun
 *
 * Note: In bankrun, we need to construct the account manually since
 * connection.getAddressLookupTable() isn't available
 *
 * @param context - ProgramTestContext from bankrun
 * @param lookupTableAddress - Address of the lookup table
 * @returns AddressLookupTableAccount or null if not found
 */
export async function getLookupTableAccount(
  context: ProgramTestContext,
  lookupTableAddress: PublicKey
): Promise<AddressLookupTableAccount | null> {
  const accountInfo = await context.banksClient.getAccount(lookupTableAddress);

  if (!accountInfo) {
    return null;
  }

  try {
    // Parse the lookup table account data
    // AddressLookupTable format:
    // - discriminator (4 bytes): indicates account type
    // - deactivation slot (8 bytes): slot when table was deactivated (u64::MAX if active)
    // - last extended slot (8 bytes): last slot the table was extended
    // - last extended slot start index (1 byte): reserved
    // - authority option (1 byte): 0 = None, 1 = Some
    // - authority (32 bytes): if authority option is Some
    // - padding to 56 bytes
    // - addresses (32 bytes each): array of addresses in the table

    const data = Buffer.from(accountInfo.data);

    // Check discriminator (should be lookup table program discriminator)
    // For now, we'll do a simple parse assuming it's a valid table

    let offset = 0;

    // Skip discriminator (4 bytes)
    offset += 4;

    // Read deactivation slot (8 bytes)
    const deactivationSlot = data.readBigUInt64LE(offset);
    offset += 8;

    // Read last extended slot (8 bytes)
    const lastExtendedSlot = data.readBigUInt64LE(offset);
    offset += 8;

    // Skip last extended slot start index (1 byte)
    offset += 1;

    // Read authority option (1 byte)
    const hasAuthority = data.readUInt8(offset);
    offset += 1;

    let authority: PublicKey | undefined;
    if (hasAuthority === 1) {
      authority = new PublicKey(data.slice(offset, offset + 32));
      offset += 32;
    }

    // Skip padding to reach address array (should be at offset 56)
    offset = 56;

    // Read addresses (32 bytes each)
    const addresses: PublicKey[] = [];
    while (offset + 32 <= data.length) {
      const addressBytes = data.slice(offset, offset + 32);
      // Check if address is not all zeros (empty slot)
      const isNonZero = addressBytes.some((byte) => byte !== 0);
      if (isNonZero) {
        addresses.push(new PublicKey(addressBytes));
      }
      offset += 32;
    }

    return new AddressLookupTableAccount({
      key: lookupTableAddress,
      state: {
        deactivationSlot: deactivationSlot === BigInt("18446744073709551615") ? undefined : deactivationSlot,
        lastExtendedSlot: Number(lastExtendedSlot),
        lastExtendedSlotStartIndex: 0,
        authority,
        addresses,
      },
    });
  } catch (error) {
    console.error("Error parsing lookup table account:", error);
    return null;
  }
}

/**
 * Create a lookup table and populate it with investor addresses in one go
 *
 * @param context - ProgramTestContext from bankrun
 * @param authority - Authority keypair for the ALT
 * @param payer - Payer for rent
 * @param investorAccounts - Array of investor account pairs [stream, ata]
 * @returns AddressLookupTableAccount ready to use
 */
export async function createAndPopulateLookupTable(
  context: ProgramTestContext,
  authority: Keypair,
  payer: Keypair,
  investorAccounts: Array<{ streamAccount: PublicKey; investorATA: PublicKey }>
): Promise<AddressLookupTableAccount> {
  // Create lookup table
  const lookupTableAddress = await createAddressLookupTable(
    context,
    authority,
    payer
  );

  // Flatten investor accounts into address array
  const addresses: PublicKey[] = [];
  for (const investor of investorAccounts) {
    addresses.push(investor.streamAccount);
    addresses.push(investor.investorATA);
  }

  // Extend lookup table with addresses (can be done in same slot as creation)
  await extendLookupTable(
    context,
    lookupTableAddress,
    authority,
    payer,
    addresses
  );

  // CRITICAL: Advance multiple slots to ensure ALT activation
  // ALTs need at least one block (slot) to activate after being extended
  // Research shows "waitForNewBlock" pattern is necessary
  let clock = await context.banksClient.getClock();
  const targetSlot = clock.slot + BigInt(3); // Advance 3 slots for safety

  // Warp one slot at a time to avoid bankrun hash verification issues
  while (clock.slot < targetSlot) {
    context.warpToSlot(clock.slot + BigInt(1));
    clock = await context.banksClient.getClock();
  }

  // Fetch and return the populated lookup table account
  const lookupTableAccount = await getLookupTableAccount(
    context,
    lookupTableAddress
  );

  if (!lookupTableAccount) {
    throw new Error("Failed to fetch lookup table account after creation");
  }

  return lookupTableAccount;
}
