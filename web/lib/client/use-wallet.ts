"use client";

import type { AppConfig } from "@stoked/shared";
import { useCallback, useEffect, useState } from "react";
import { getGiftClient } from "./index";
import {
  connectExtension,
  connectedAddress,
  forgetWallet,
  takePhantomReturn,
  walletMode,
  type WalletMode,
} from "./phantom";

let known: AppConfig | null = null;

/** What this deployment asks of senders; null until known. Retries until it answers. */
export function useAppConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    // It doesn't change while the tab is open. (Read here so server and first client render agree.)
    if (known) return setConfig(known);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        known = await getGiftClient().getConfig();
        if (!stopped) setConfig(known);
      } catch {
        if (!stopped) timer = setTimeout(read, 3000);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return config;
}

/** The Phantom connection in this browser; `mode` is null until the page has mounted. */
export function useWallet() {
  const [state, setState] = useState<{ mode: WalletMode | null; address: string | null }>({ mode: null, address: null });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    // A reply from the Phantom app is what connects the wallet, so read it first.
    takePhantomReturn();
    setState({ mode: walletMode(), address: connectedAddress() });
  }, []);
  useEffect(() => {
    refresh();
    // Coming back from the app can restore this page without reloading it.
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setError(null);
    try {
      await connectExtension();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Phantom didn't connect. Try again.");
    }
    refresh();
  }, [refresh]);

  const disconnect = useCallback(() => {
    setError(null);
    forgetWallet();
    refresh();
  }, [refresh]);

  return { ...state, error, connect, disconnect, refresh };
}
