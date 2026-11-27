/** A stand-in payment token for tests and local runs. Never used by the app. */
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { assertSafeCluster } from "../src/cluster";

/** A 6-decimal token like USDC, with `authority` paying and able to mint. */
export async function createTestPaymentMint(connection: Connection, authority: Keypair): Promise<PublicKey> {
  await assertSafeCluster(connection);
  return createMint(connection, authority, authority.publicKey, null, 6);
}

export async function mintTestPayment(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<void> {
  await assertSafeCluster(connection);
  const account = await getOrCreateAssociatedTokenAccount(connection, authority, mint, owner);
  await mintTo(connection, authority, mint, account.address, authority, amount);
}

/** Base units held in the owner's associated token account, 0 if it doesn't exist. */
export async function testPaymentBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const address = getAssociatedTokenAddressSync(mint, owner);
  if (!(await connection.getAccountInfo(address, "confirmed"))) return 0n;
  return BigInt((await connection.getTokenAccountBalance(address, "confirmed")).value.amount);
}
