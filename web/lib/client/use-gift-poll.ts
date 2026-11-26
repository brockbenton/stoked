"use client";

import type { PublicGift } from "@stoked/shared";
import { useEffect, useRef } from "react";
import { getGiftClient } from "./index";

export const POLL_ACTIVE_MS = 3000;
/** A claimed gift only changes in value (price or multiplier), so check less often. */
export const POLL_CLAIMED_MS = 15_000;

const RANK: Record<PublicGift["status"], number> = { wrapped: 0, opened: 1, claiming: 2, claimed: 3 };

/** True if `next` is not an older state than `current`. */
export function isNotOlder(next: PublicGift, current: PublicGift): boolean {
  return RANK[next.status] >= RANK[current.status];
}

/**
 * Keep a shown gift current while the tab is visible. `version` must change
 * whenever this tab changes the gift itself, so that a poll sent before the
 * change can't overwrite it. Failed polls are ignored and retried.
 */
export function useGiftPoll(
  gift: PublicGift | null,
  onGift: (g: PublicGift) => void,
  version?: { readonly current: number },
) {
  const latest = useRef({ gift, onGift });
  latest.current = { gift, onGift };
  const id = gift?.id;
  const claimed = gift?.status === "claimed";

  useEffect(() => {
    if (!id) return;
    const every = claimed ? POLL_CLAIMED_MS : POLL_ACTIVE_MS;
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (!busy && document.visibilityState === "visible") {
        busy = true;
        const sentAt = version?.current;
        try {
          const next = await getGiftClient().getGift(id);
          const current = latest.current.gift;
          if (!stopped && current && sentAt === version?.current && isNotOlder(next, current)) {
            latest.current.onGift(next);
          }
        } catch {
          // Keep showing what we have; the next tick tries again.
        }
        busy = false;
      }
      if (!stopped) {
        clearTimeout(timer);
        timer = setTimeout(tick, every);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    timer = setTimeout(tick, every);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, claimed, version]);
}
