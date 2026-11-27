"use client";

import type { PayState } from "@/lib/client/use-payment";
import type { useWallet } from "@/lib/client/use-wallet";
import { shortAddress } from "@/lib/format";
import { ConnectPhantom } from "./ConnectPhantom";
import { GiftIcon } from "./icons";

const BUSY: Partial<Record<PayState["k"], string>> = {
  preparing: "Preparing…",
  signing: "Waiting for Phantom…",
  confirming: "Confirming on Solana…",
};

/** The foot of the compose form when senders pay: connect, pay, approve, confirm. */
export function PayActions({
  wallet,
  state,
  price,
  what,
  onConfirm,
  onCancel,
}: {
  wallet: ReturnType<typeof useWallet>;
  state: PayState;
  /** "10 USDC" */
  price: string;
  /** "Nvidia" */
  what: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const busy = BUSY[state.k];
  return (
    <div className="pay">
      {state.k === "failed" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
      {wallet.error && (
        <p className="error" role="alert">
          {wallet.error}
        </p>
      )}
      {state.k === "approve" ? (
        <>
          <div className="notice" role="status">
            <p>
              <strong>Approve {price} in Phantom.</strong> You&rsquo;ll come back here to get the gift link.
            </p>
          </div>
          <a className="btn btn--primary" href={state.link.href} onClick={state.link.arm}>
            Approve in Phantom
          </a>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : state.k === "stuck" ? (
        <>
          <div className="notice" role="status">
            <p>
              <strong>Still confirming.</strong> Don&rsquo;t pay again: check back in a moment.
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            Check again
          </button>
        </>
      ) : busy ? (
        <button type="button" className="btn btn--primary btn--wrap" disabled aria-busy>
          {busy}
        </button>
      ) : wallet.address ? (
        <>
          <p className="wallet-line">
            Paying from Phantom {shortAddress(wallet.address)}{" "}
            <button type="button" className="quiet" onClick={wallet.disconnect}>
              Change
            </button>
          </p>
          <button type="submit" className="btn btn--primary btn--wrap">
            <GiftIcon className="btn__icon" />
            Pay {price} and wrap {what}
          </button>
        </>
      ) : wallet.mode ? (
        <>
          <p className="wallet-line">Gifts are paid from your wallet: {price} on devnet.</p>
          <ConnectPhantom mode={wallet.mode} onConnect={wallet.connect} />
        </>
      ) : null}
    </div>
  );
}
