/**
 * Cluster guard. The URL alone proves nothing (a proxy or a typo can point
 * anywhere), so we ask the node for its genesis hash and refuse anything that
 * is not devnet or a local validator. Every function that signs calls this
 * first.
 */
import type { Connection } from "@solana/web3.js";

export const GENESIS_HASHES = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;

export type SafeCluster = "devnet" | "local";

export class UnsafeClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeClusterError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function isLocalEndpoint(endpoint: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the cluster behind `connection` by genesis hash.
 * - mainnet and testnet: refused, always.
 * - devnet: allowed.
 * - any other genesis hash: allowed only on a loopback endpoint (a local
 *   solana-test-validator has a fresh genesis hash every reset).
 */
export async function assertSafeCluster(
  connection: Pick<Connection, "getGenesisHash" | "rpcEndpoint">,
): Promise<SafeCluster> {
  const hash = await connection.getGenesisHash();
  if (hash === GENESIS_HASHES.mainnet) {
    throw new UnsafeClusterError("refusing to run against mainnet-beta (genesis hash matches mainnet)");
  }
  if (hash === GENESIS_HASHES.testnet) {
    throw new UnsafeClusterError("refusing to run against testnet; use devnet or a local validator");
  }
  if (hash === GENESIS_HASHES.devnet) return "devnet";
  if (isLocalEndpoint(connection.rpcEndpoint)) return "local";
  throw new UnsafeClusterError(
    `unknown cluster (genesis ${hash}) at a non-local endpoint; only devnet or a local validator is allowed`,
  );
}
