"use client";

import { createFixtureClient, fixtureWallet, parseSim } from "./fixture";
import { createHttpClient } from "./http";
import type { GiftClient, WalletSource } from "./types";
import { browserWallet } from "./wallet";

export * from "./types";

/** UI tests build with NEXT_PUBLIC_STOKED_CLIENT=fixture; everything else talks to the real API. */
const useFixtures = process.env.NEXT_PUBLIC_STOKED_CLIENT === "fixture";

let client: GiftClient | undefined;

/** One client per tab, so a fixture gift created on compose survives client-side navigation. */
export function getGiftClient(): GiftClient {
  client ??= useFixtures
    ? createFixtureClient({ sim: parseSim(typeof window === "undefined" ? "" : window.location.search) })
    : createHttpClient();
  return client;
}

export function getWallet(): WalletSource {
  return useFixtures ? fixtureWallet : browserWallet;
}

/** Token from the link fragment, `#t=…`. Fragments never reach the server. */
export function readTokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("t") ?? "";
}
