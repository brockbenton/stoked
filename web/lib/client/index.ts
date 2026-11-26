"use client";

import { createFixtureClient, fixtureWallet, parseSim } from "./fixture";
import type { GiftClient, WalletSource } from "./types";

export * from "./types";

let client: GiftClient | undefined;

/**
 * One client per tab, so a gift created on compose is still there after
 * client-side navigation. Fixture-backed until G4 wires the API.
 */
export function getGiftClient(): GiftClient {
  client ??= createFixtureClient({ sim: parseSim(typeof window === "undefined" ? "" : window.location.search) });
  return client;
}

export function getWallet(): WalletSource {
  return fixtureWallet;
}

/** Token from the link fragment, `#t=…`. Fragments never reach the server. */
export function readTokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("t") ?? "";
}
