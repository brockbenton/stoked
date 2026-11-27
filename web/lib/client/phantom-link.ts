/**
 * Phantom's deeplinks (docs.phantom.com/phantom-deeplinks): how a page in a
 * phone browser asks the Phantom app to connect or sign. The person goes to the
 * app, approves, and comes back to `redirect` with an encrypted answer.
 * Pure functions; ./phantom.ts keeps the keys between the two visits.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";

const BASE = "https://phantom.com/ul/v1/";
export const CLUSTER = "devnet";

export interface LinkKeys {
  publicKey: string;
  secretKey: string;
}

export interface Session {
  keys: LinkKeys;
  phantomKey: string;
  session: string;
  address: string;
}

export function newLinkKeys(): LinkKeys {
  const pair = nacl.box.keyPair();
  return { publicKey: bs58.encode(pair.publicKey), secretKey: bs58.encode(pair.secretKey) };
}

export function connectUrl(i: { appUrl: string; redirect: string; keys: LinkKeys }): string {
  const q = new URLSearchParams({
    app_url: i.appUrl,
    dapp_encryption_public_key: i.keys.publicKey,
    redirect_link: i.redirect,
    cluster: CLUSTER,
  });
  return `${BASE}connect?${q}`;
}

export class PhantomLinkError extends Error {
  constructor(
    message: string,
    /** The person said no, as opposed to something going wrong. */
    readonly declined = false,
  ) {
    super(message);
    this.name = "PhantomLinkError";
  }
}

/** Phantom reports a refusal or failure as query parameters. */
function refusal(q: URLSearchParams) {
  const code = q.get("errorCode");
  if (code === null) return;
  if (code === "4001") throw new PhantomLinkError("You declined in Phantom. Nothing was sent.", true);
  throw new PhantomLinkError("Phantom couldn't finish that. Connect and try again.");
}

function open(q: URLSearchParams, secret: Uint8Array): Record<string, unknown> {
  const data = q.get("data");
  const nonce = q.get("nonce");
  try {
    const plain = data && nonce ? nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), secret) : null;
    if (plain) return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new PhantomLinkError("Phantom's reply couldn't be read. Connect and try again.");
}

const shared = (phantomKey: string, keys: LinkKeys) =>
  nacl.box.before(bs58.decode(phantomKey), bs58.decode(keys.secretKey));

export function readConnect(q: URLSearchParams, keys: LinkKeys): Session {
  refusal(q);
  const phantomKey = q.get("phantom_encryption_public_key");
  if (!phantomKey) throw new PhantomLinkError("Phantom's reply couldn't be read. Connect and try again.");
  let secret: Uint8Array;
  try {
    secret = shared(phantomKey, keys);
  } catch {
    throw new PhantomLinkError("Phantom's reply couldn't be read. Connect and try again.");
  }
  const { public_key, session } = open(q, secret);
  if (typeof public_key !== "string" || typeof session !== "string") {
    throw new PhantomLinkError("Phantom's reply couldn't be read. Connect and try again.");
  }
  return { keys, phantomKey, session, address: public_key };
}

/** `transaction` is base58, unsigned. */
export function signUrl(i: { redirect: string; session: Session; transaction: string }): string {
  const nonce = nacl.randomBytes(24);
  const payload = new TextEncoder().encode(JSON.stringify({ transaction: i.transaction, session: i.session.session }));
  const q = new URLSearchParams({
    dapp_encryption_public_key: i.session.keys.publicKey,
    nonce: bs58.encode(nonce),
    redirect_link: i.redirect,
    payload: bs58.encode(nacl.box.after(payload, nonce, shared(i.session.phantomKey, i.session.keys))),
  });
  return `${BASE}signTransaction?${q}`;
}

/** The signed transaction, base58. */
export function readSigned(q: URLSearchParams, session: Session): string {
  refusal(q);
  const { transaction } = open(q, shared(session.phantomKey, session.keys));
  if (typeof transaction !== "string") {
    throw new PhantomLinkError("Phantom's reply couldn't be read. Connect and try again.");
  }
  return transaction;
}
