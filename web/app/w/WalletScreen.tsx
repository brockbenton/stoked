"use client";

import type { WalletResponse } from "@stoked/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getGiftClient, getWallet } from "@/lib/client";
import { explorerAddressUrl, stockName, stockSymbol } from "@/lib/format";

type State =
  | { k: "loading" }
  | { k: "none" }
  | { k: "unavailable" }
  | { k: "ready"; address: string; holdings: WalletResponse["holdings"] | null; error: boolean };

/** The wallet kept in this browser and the test tokens it holds. Never creates one. */
export function WalletScreen() {
  const [state, setState] = useState<State>({ k: "loading" });
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    let address: string | null;
    try {
      address = await getWallet().peekAddress();
    } catch {
      return setState({ k: "unavailable" });
    }
    if (!address) return setState({ k: "none" });
    setState((s) => (s.k === "ready" ? s : { k: "ready", address, holdings: null, error: false }));
    try {
      const { holdings } = await getGiftClient().getWallet(address);
      setState({ k: "ready", address, holdings, error: false });
    } catch {
      // Keep the last balances on screen, marked as possibly out of date.
      setState((s) => (s.k === "ready" ? { ...s, error: true } : s));
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  return (
    <main className="page page--gift">
      <header className="topbar">
        <Link href="/" className="wordmark">
          Stoked
        </Link>
      </header>
      <section className="wallet" aria-labelledby="wallet-title">
        <h1 id="wallet-title" className="sent__title">
          Your wallet
        </h1>
        {state.k === "loading" && <p className="meta">Loading your wallet…</p>}
        {state.k === "none" && (
          <p className="sent__text">There&rsquo;s no wallet in this browser yet. One is created when you claim a gift.</p>
        )}
        {state.k === "unavailable" && (
          <p className="sent__text">This browser can&rsquo;t keep a wallet. Try an up-to-date browser, outside private mode.</p>
        )}
        {state.k === "ready" && (
          <>
            <div className="note">
              <p className="label">Address</p>
              <p className="wallet__address" data-testid="wallet-address">
                {state.address}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.address);
                  setCopied(true);
                } catch {
                  // The address is selectable on screen.
                }
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            <a className="meta__link wallet__explorer" href={explorerAddressUrl(state.address)} target="_blank" rel="noreferrer">
              View on explorer
            </a>
            <h2 className="label">Tokens</h2>
            {state.holdings === null && !state.error && <p className="meta">Loading balances…</p>}
            {state.holdings?.length === 0 && <p className="sent__text">No tokens yet.</p>}
            {state.holdings && state.holdings.length > 0 && (
              <ul className="holdings">
                {state.holdings.map((h) => (
                  <li key={h.ticker} className="holding" data-testid={`holding-${h.ticker}`}>
                    <span className="holding__name">
                      <span className="choice__sym">{stockSymbol(h.ticker)}</span>
                      <span className="choice__name">
                        {stockName(h.ticker)} · {h.ticker}
                      </span>
                    </span>
                    <span className="holding__amount">{h.sharesExact}</span>
                  </li>
                ))}
              </ul>
            )}
            {state.error && (
              <p className="error" role="alert">
                Couldn&rsquo;t check balances just now.
              </p>
            )}
            <button type="button" className="btn btn--secondary" onClick={() => void refresh()}>
              Refresh
            </button>
            <p className="fine">
              This wallet lives only in this browser. Clearing site data loses it.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
