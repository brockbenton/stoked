/**
 * The recipient's wallet: an Ed25519 key pair made by WebCrypto on this device
 * and kept in IndexedDB. The private key is non-extractable, so not even this
 * page can read its bytes; only the public address is ever sent anywhere.
 * Clearing site data destroys it, which is acceptable for devnet test tokens.
 */
import bs58 from "bs58";
import { GiftClientError, type WalletSource } from "./types";

export const WALLET_DB = "stoked-wallet";
export const WALLET_STORE = "keys";
export const WALLET_KEY = "primary";

interface StoredWallet {
  address: string;
  keyPair: CryptoKeyPair;
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const open = indexedDB.open(WALLET_DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(WALLET_STORE);
  const db = await result(open);
  try {
    const tx = db.transaction(WALLET_STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const value = await fn(tx.objectStore(WALLET_STORE));
    await done;
    return value;
  } finally {
    db.close();
  }
}

const read = () =>
  withStore("readonly", (s) => result(s.get(WALLET_KEY) as IDBRequest<StoredWallet | undefined>));

async function create(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const address = bs58.encode(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
  // One transaction for check-and-write: if another tab made a wallet first, keep theirs.
  return withStore("readwrite", async (s) => {
    const existing = await result(s.get(WALLET_KEY) as IDBRequest<StoredWallet | undefined>);
    if (existing) return existing.address;
    await result(s.add({ address, keyPair } satisfies StoredWallet, WALLET_KEY));
    return address;
  });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new GiftClientError("wallet_unavailable", "This browser can't keep a wallet");
  }
}

export const browserWallet: WalletSource = {
  peekAddress: () => guard(async () => (await read())?.address ?? null),
  getAddress: () => guard(async () => (await read())?.address ?? (await create())),
};
