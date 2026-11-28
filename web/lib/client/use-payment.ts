"use client";

/**
 * Paying for a gift from the sender's wallet: prepare, approve in Phantom,
 * submit until confirmed. On a phone, approving leaves the page, and the reply
 * may open in a new tab, so each step is kept in this browser until it ends.
 */
import type { CreateGiftRequest } from "@stoked/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGiftClient } from "./index";
import {
  signLink,
  signWithExtension,
  takePhantomReturn,
  walletMode,
  type PhantomLink,
  type PhantomReturn,
} from "./phantom";
import { GiftClientError } from "./types";

const PAYING = "stoked-paying";
const SENT = "stoked-sent";
const RETRY_MS = 2000;
/** Submit attempts before offering "Check again". */
const ATTEMPTS = 60;

export interface SentGift {
  id: string;
  link: string;
  request: CreateGiftRequest;
  /** The payment transaction, when known. */
  signature: string | null;
}

interface Paying {
  id: string;
  token: string;
  ticket: string;
  request: CreateGiftRequest;
  /** Present once the wallet has signed. */
  transaction?: string;
}

export type PayState =
  | { k: "idle" }
  | { k: "preparing" }
  /** Phone: waiting for the person to tap through to Phantom. */
  | { k: "approve"; link: PhantomLink }
  | { k: "signing" }
  | { k: "confirming" }
  | { k: "stuck" }
  | { k: "failed"; message: string };

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the flow still works if the page isn't left.
  }
}

function messageOf(e: unknown): string {
  if (!(e instanceof Error)) return "Couldn't wrap the gift. Try again.";
  if (e instanceof GiftClientError) {
    if (e.code === "rate_limited") return "Too many gifts from here right now. Wait a minute and try again.";
    if (e.code === "offline") return "You're offline. Connect and try again.";
    if (e.code === "insufficient_funds" || e.code === "payment_rejected") return e.message;
    return "Couldn't wrap the gift. Try again.";
  }
  // Wallet messages are written to be shown.
  return e.message;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replies already acted on, so a remounted form doesn't reuse a signature. */
const handled = new WeakSet<PhantomReturn>();

export function usePayment(enabled: boolean) {
  const [state, setState] = useState<PayState>({ k: "idle" });
  const [sent, setSent] = useState<SentGift | null>(null);
  const running = useRef(false);

  /** Submit the signed payment until the gift is locked on chain. */
  const confirm = useCallback(async () => {
    const paying = read<Paying>(PAYING);
    if (!paying?.transaction || running.current) return;
    running.current = true;
    setState({ k: "confirming" });
    try {
      for (let i = 0; i < ATTEMPTS; i++) {
        try {
          const r = await getGiftClient().submitGift(paying.token, {
            ticket: paying.ticket,
            transaction: paying.transaction,
          });
          if (r.status === "confirmed") {
            const done: SentGift = {
              id: paying.id,
              link: `${window.location.origin}/g/${paying.id}#t=${paying.token}`,
              request: paying.request,
              signature: r.signature,
            };
            write(SENT, done);
            write(PAYING, null);
            setSent(done);
            setState({ k: "idle" });
            return;
          }
        } catch (e) {
          const code = e instanceof GiftClientError ? e.code : "internal";
          // These are final answers; anything else may be passing, and submitting again is safe.
          if (["payment_rejected", "validation_failed", "forbidden", "unauthorized", "invalid_state"].includes(code)) {
            write(PAYING, null);
            setState({ k: "failed", message: messageOf(e) });
            return;
          }
        }
        await sleep(RETRY_MS);
      }
      setState({ k: "stuck" });
    } finally {
      running.current = false;
    }
  }, []);

  // Pick up where this browser left off, including a reply from Phantom.
  useEffect(() => {
    if (!enabled) return;
    const reply = takePhantomReturn();
    const back = reply && !handled.has(reply) ? reply : null;
    if (reply) handled.add(reply);
    const paying = read<Paying>(PAYING);
    if (back?.action === "sign" && paying) {
      if (back.ok) {
        write(PAYING, { ...paying, transaction: back.transaction });
      } else {
        write(PAYING, null);
        setState({ k: "failed", message: back.message });
        return;
      }
    } else if (back && !back.ok) {
      setState({ k: "failed", message: back.message });
    }
    const resumed = read<Paying>(PAYING);
    if (resumed?.transaction) return void confirm();
    const done = read<SentGift>(SENT);
    if (done) setSent(done);
  }, [enabled, confirm]);

  const pay = useCallback(
    async (request: CreateGiftRequest, senderWallet: string) => {
      setState({ k: "preparing" });
      try {
        const p = await getGiftClient().prepareGift({ gift: request, senderWallet });
        const paying: Paying = { id: p.id, token: p.claimToken, ticket: p.ticket, request };
        write(PAYING, paying);
        if (walletMode() === "app") {
          setState({ k: "approve", link: signLink(p.transaction) });
          return;
        }
        setState({ k: "signing" });
        const transaction = await signWithExtension(p.transaction);
        write(PAYING, { ...paying, transaction });
        await confirm();
      } catch (e) {
        write(PAYING, null);
        setState({ k: "failed", message: messageOf(e) });
      }
    },
    [confirm],
  );

  const cancel = useCallback(() => {
    write(PAYING, null);
    setState({ k: "idle" });
  }, []);

  const clearSent = useCallback(() => {
    write(SENT, null);
    setSent(null);
  }, []);

  return { state, sent, pay, confirm, cancel, clearSent };
}
