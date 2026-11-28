/**
 * The Phantom wallet, however this browser can reach it: an injected provider
 * (the desktop extension, or Phantom's own browser), or on a phone, links that
 * open the Phantom app and come back here. Only the public address and signed
 * transactions pass through; keys stay in Phantom.
 */
import bs58 from "bs58";
import {
  PhantomLinkError,
  connectUrl,
  newLinkKeys,
  readConnect,
  readSigned,
  signUrl,
  type LinkKeys,
  type Session,
} from "./phantom-link";

export const PHANTOM_DOWNLOAD = "https://phantom.com/download";
const KEY = "stoked-phantom";
/** How long a trip to the app may take before its reply is ignored. */
const PENDING_MS = 15 * 60_000;

export type WalletMode = "extension" | "app" | "none";

interface Provider {
  isPhantom?: boolean;
  isBraveWallet?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction<T>(transaction: T): Promise<T>;
  disconnect?(): Promise<void>;
}

interface Pending {
  action: "connect" | "sign";
  /** Where the reply must arrive, and the fragment (the claim token) to put back. */
  path: string;
  hash: string;
  at: number;
}

interface Stored {
  address?: string;
  session?: Session;
  /** Keys sent with a connect link that hasn't been answered. */
  keys?: LinkKeys;
  pending?: Pending;
}

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

function save(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode: the reply won't be recognised, and says so.
  }
}

function provider(): Provider | null {
  const w = window as unknown as { phantom?: { solana?: Provider }; solana?: Provider };
  // Brave's built-in wallet also says it is Phantom.
  return [w.phantom?.solana, w.solana].find((p) => p?.isPhantom && !p.isBraveWallet) ?? null;
}

function isPhone(): boolean {
  const ua = navigator.userAgent;
  // iPads report themselves as Macs.
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function walletMode(): WalletMode {
  if (provider()) return "extension";
  return isPhone() ? "app" : "none";
}

/** The connected address, if this browser can still use it. */
export function connectedAddress(): string | null {
  const s = load();
  // A phone connection is only usable with the session that came with it.
  if (!s.address || (walletMode() === "app" && !s.session)) return null;
  return s.address;
}

export function forgetWallet() {
  void provider()
    ?.disconnect?.()
    .catch(() => {});
  save({});
}

export async function connectExtension(): Promise<string> {
  const p = provider();
  if (!p) throw new PhantomLinkError("Phantom isn't available in this browser.");
  let address: string;
  try {
    address = (await p.connect()).publicKey.toString();
  } catch {
    throw new PhantomLinkError("Phantom didn't connect. Try again.", true);
  }
  save({ address });
  return address;
}

/** Sign a base58 transaction with the injected provider; returns it signed, base58. */
export async function signWithExtension(transaction: string): Promise<string> {
  const p = provider();
  if (!p) throw new PhantomLinkError("Phantom isn't available in this browser.");
  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(bs58.decode(transaction));
  const from = tx.feePayer?.toString();
  let signed: typeof tx;
  try {
    const { publicKey } = await p.connect();
    if (publicKey.toString() !== from) {
      save({ address: publicKey.toString() });
      throw new PhantomLinkError("Phantom switched wallets. Try again.");
    }
    signed = await p.signTransaction(tx);
  } catch (err) {
    if (err instanceof PhantomLinkError) throw err;
    throw new PhantomLinkError("Phantom didn't sign. Nothing was sent.", true);
  }
  return bs58.encode(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/**
 * A link for the person to tap: iOS only reliably opens an app from a real tap.
 * `arm` (call it on click) remembers what's needed to read the reply.
 */
export interface PhantomLink {
  href: string;
  arm(): void;
}

const redirectTo = (path: string, action: Pending["action"]) => `${window.location.origin}${path}?phantom=${action}`;

const pendingFor = (action: Pending["action"]): Pending => ({
  action,
  path: window.location.pathname,
  hash: window.location.hash,
  at: Date.now(),
});

export function connectLink(): PhantomLink {
  const keys = newLinkKeys();
  return {
    href: connectUrl({
      appUrl: window.location.origin,
      redirect: redirectTo(window.location.pathname, "connect"),
      keys,
    }),
    arm: () => save({ keys, pending: pendingFor("connect") }),
  };
}

export function signLink(transaction: string): PhantomLink {
  const { session } = load();
  if (!session) throw new PhantomLinkError("Connect Phantom again.");
  return {
    href: signUrl({ redirect: redirectTo(window.location.pathname, "sign"), session, transaction }),
    arm: () => save({ ...load(), pending: pendingFor("sign") }),
  };
}

export type PhantomReturn =
  | { action: "connect"; ok: true }
  | { action: "sign"; ok: true; transaction: string }
  | { action: "connect" | "sign"; ok: false; message: string };

let taken: { url: string; result: PhantomReturn | null } | undefined;

/**
 * Read a reply from the Phantom app, if this page load is one, and restore the
 * page's address (including the claim token). Safe to call more than once.
 */
export function takePhantomReturn(): PhantomReturn | null {
  const q = new URLSearchParams(window.location.search);
  const action = q.get("phantom");
  if (action !== "connect" && action !== "sign") return taken?.url === window.location.pathname ? taken.result : null;
  const stored = load();
  const { pending } = stored;
  const mine =
    pending && pending.action === action && pending.path === window.location.pathname && Date.now() - pending.at < PENDING_MS;
  // Clean the address first: the reply shouldn't survive a reload or be shared.
  window.history.replaceState(window.history.state, "", window.location.pathname + (mine ? pending.hash : ""));
  let result: PhantomReturn;
  try {
    if (!mine) {
      throw new PhantomLinkError("Phantom came back somewhere this page doesn't recognise. Open your link again.");
    }
    if (action === "connect") {
      if (!stored.keys) throw new PhantomLinkError("Connect Phantom again.");
      const session = readConnect(q, stored.keys);
      save({ address: session.address, session });
      result = { action, ok: true };
    } else {
      if (!stored.session) throw new PhantomLinkError("Connect Phantom again.");
      const transaction = readSigned(q, stored.session);
      save({ address: stored.address, session: stored.session });
      result = { action, ok: true, transaction };
    }
  } catch (err) {
    const declined = err instanceof PhantomLinkError && err.declined;
    // A refusal keeps the connection; anything else may mean the session is bad.
    if (mine) save(declined ? { address: stored.address, session: stored.session } : {});
    result = {
      action,
      ok: false,
      message: err instanceof PhantomLinkError ? err.message : "Phantom couldn't finish that. Try again.",
    };
  }
  taken = { url: window.location.pathname, result };
  return result;
}
