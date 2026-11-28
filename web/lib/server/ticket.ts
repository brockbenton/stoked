/**
 * The terms of a wallet-paid gift, held by the browser between prepare and
 * submit. Signed by the server, so nothing is stored for an unpaid gift and
 * the browser can't change the price or the amount. Holds no secrets.
 */
import type { Ticker } from "@stoked/shared";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PaymentTicket {
  /** Database id the gift will have. */
  id: string;
  /** The escrow's random gift id, hex. */
  seed: string;
  sender: string;
  ticker: Ticker;
  usdCents: number;
  priceCents: number;
  tokenRaw: string;
  /** Price in the payment token's base units. */
  amount: string;
  senderName: string;
  recipientName: string;
  note: string | null;
  opensAt: string | null;
  openAt: number;
  expiresAt: number;
  tokenHash: string;
  /** What the transaction was built on; bounds when it can still land. */
  recent: { blockhash: string; lastValidBlockHeight: number };
  /** Server clock, ISO. */
  issuedAt: string;
}

const mac = (key: Uint8Array, body: string) => createHmac("sha256", key).update(body).digest();

export function signTicket(key: Uint8Array, ticket: PaymentTicket): string {
  const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

/** The ticket, or null if this server didn't sign exactly these bytes. */
export function readTicket(key: Uint8Array, value: string): PaymentTicket | null {
  const [body, tag, extra] = value.split(".");
  if (!body || !tag || extra !== undefined) return null;
  const given = Buffer.from(tag, "base64url");
  const wanted = mac(key, body);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PaymentTicket;
}
