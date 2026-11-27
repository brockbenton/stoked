"use client";

import { shortAddress } from "@/lib/format";
import { useAppConfig, useWallet } from "@/lib/client/use-wallet";
import { ConnectPhantom } from "./ConnectPhantom";

/** Where the gift goes: the connected Phantom wallet, or a wallet made in this browser. */
export type WalletChoice = "phantom" | "browser";

/** The claim button, or on a wallet deployment, connecting a wallet and then claiming to it. */
export function ClaimActions({
  sending,
  enabled,
  onClaim,
}: {
  sending: boolean;
  enabled: boolean;
  onClaim: (choice: WalletChoice) => void;
}) {
  const config = useAppConfig();
  const wallet = useWallet();

  const claim = (label: string, choice: WalletChoice, primary: boolean) => (
    <button
      type="button"
      className={`btn ${primary ? "btn--primary" : "btn--secondary"}`}
      onClick={() => onClaim(choice)}
      // Stay focusable while sending (aria-disabled), so focus isn't dropped to <body>.
      disabled={!enabled}
      aria-disabled={sending}
      aria-busy={sending}
    >
      {sending ? "Claiming…" : label}
    </button>
  );

  // Until the deployment answers, show the button but don't act on it.
  if (!config || (config.payment && wallet.mode === null)) {
    return (
      <button type="button" className="btn btn--primary" disabled>
        Claim to my wallet
      </button>
    );
  }
  if (!config.payment) return claim("Claim to my wallet", "browser", true);

  if (wallet.address) {
    return (
      <>
        <p className="wallet-line">Phantom wallet {shortAddress(wallet.address)}</p>
        {claim("Claim to my Phantom wallet", "phantom", true)}
        <button type="button" className="quiet" onClick={wallet.disconnect} disabled={sending}>
          Use a different wallet
        </button>
      </>
    );
  }
  return (
    <>
      {wallet.mode !== "none" && <ConnectPhantom mode={wallet.mode!} onConnect={wallet.connect} />}
      {wallet.error && (
        <p className="error" role="alert">
          {wallet.error}
        </p>
      )}
      {claim("Create a wallet here instead", "browser", wallet.mode === "none")}
      {wallet.mode === "none" && <ConnectPhantom mode="none" onConnect={wallet.connect} primary={false} />}
    </>
  );
}
