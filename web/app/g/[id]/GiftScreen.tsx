"use client";

import { formatUsd, TICKERS, type PublicGift, type Ticker } from "@stoked/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardMeta, OpenedCard, WrappedCard } from "@/components/Cards";
import { GiftBox } from "@/components/GiftBox";
import { Sheet } from "@/components/Sheet";
import { ValueLine } from "@/components/ValueLine";
import { GiftClientError, getGiftClient, getWallet, readTokenFromHash } from "@/lib/client";
import { useGiftPoll } from "@/lib/client/use-gift-poll";
import { formatOpensAt, shortAddress, stockName, stockSymbol } from "@/lib/format";

type Load = { k: "loading" } | { k: "error"; code: string } | { k: "ready"; gift: PublicGift };
type SheetState = null | "box" | "unwrapping" | "reveal";
type Claim =
  | { k: "idle" }
  | { k: "sending" }
  | { k: "pending"; stuck: boolean }
  | { k: "failed"; message: string };

const UNWRAP_MS = 1200;
const REDUCED_MS = 250;
const POLL_MS = 1500;
const POLLS_BEFORE_STUCK = 6;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function codeOf(e: unknown): string {
  return e instanceof GiftClientError ? e.code : "internal";
}

export function GiftScreen({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ k: "loading" });
  const [token, setToken] = useState("");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [claim, setClaim] = useState<Claim>({ k: "idle" });
  const [tooEarly, setTooEarly] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);
  const [offline, setOffline] = useState(false);
  const polling = useRef(false);
  // Bumped when this tab changes the gift, so an older background poll can't undo it.
  const version = useRef(0);

  const gift = load.k === "ready" ? load.gift : null;
  const setGift = useCallback((g: PublicGift) => {
    version.current += 1;
    setLoad({ k: "ready", gift: g });
  }, []);

  const unwrapping = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const claimRef = useRef(claim);
  claimRef.current = claim;

  const fetchGift = useCallback(async () => {
    setLoad({ k: "loading" });
    // Read the token here: state from the mount effect isn't set yet on first load.
    const hasToken = readTokenFromHash(window.location.hash).length > 0;
    try {
      const g = await getGiftClient().getGift(id);
      setLoad({ k: "ready", gift: g });
      // Only the recipient (link with a token) gets the reveal and claim sheet.
      if (hasToken && g.status === "opened") setSheet("reveal");
      if (hasToken && g.status === "claiming") {
        setSheet("reveal");
        setClaim({ k: "pending", stuck: false });
      }
      if (g.status === "claimed") setAlreadyClaimed(true);
    } catch (e) {
      setLoad({ k: "error", code: codeOf(e) });
    }
  }, [id]);

  const closeSheet = useCallback(() => setSheet(null), []);

  useEffect(() => {
    setToken(readTokenFromHash(window.location.hash));
    setOffline(!navigator.onLine);
    // Pasting the private link over the public one only changes the fragment: no reload.
    const onHash = () => {
      setToken(readTokenFromHash(window.location.hash));
      void fetchGift();
    };
    const on = () => {
      setOffline(false);
      // Reload if the page couldn't load while offline.
      if (loadRef.current.k === "error") void fetchGift();
    };
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("hashchange", onHash);
    void fetchGift();
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [fetchGift]);

  const finishClaim = useCallback(
    async (g: PublicGift) => {
      // Say "your wallet" only if it is: the claim may have been made on another device.
      // Look it up first, so the sheet closes in the same render that shows the notice
      // and focus can move to it.
      const mine = await getWallet()
        .peekAddress()
        .catch(() => null);
      setGift(g);
      setClaim({ k: "idle" });
      setSheet(null);
      if (g.status === "claimed" && g.recipientWallet === mine) setJustClaimed(true);
      else setAlreadyClaimed(true);
    },
    [setGift],
  );

  /** A change seen by the background poll: another tab or device acted on the gift. */
  useGiftPoll(
    gift,
    (g) => {
      const before = loadRef.current.k === "ready" ? loadRef.current.gift.status : null;
      if (g.status === "claimed" && before !== "claimed") {
        if (claimRef.current.k === "idle") {
          setLoad({ k: "ready", gift: g });
          setSheet(null);
          setAlreadyClaimed(true);
        } else void finishClaim(g);
        return;
      }
      setLoad({ k: "ready", gift: g });
      if (!token) return;
      if (g.status !== "wrapped") setSheet((s) => (s === "box" ? "reveal" : s));
      if (g.status === "claiming" && claimRef.current.k === "idle") setClaim({ k: "pending", stuck: false });
    },
    version,
  );

  /**
   * While a claim is pending, repeat the claim request: that is what moves it
   * forward on the server, and it can never pay twice. Flag it as stuck
   * (retryable) after a while.
   */
  useEffect(() => {
    if (claim.k !== "pending" || claim.stuck || polling.current) return;
    polling.current = true;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < POLLS_BEFORE_STUCK && !cancelled; i++) {
        await sleep(POLL_MS);
        if (cancelled) break;
        try {
          const current = loadRef.current.k === "ready" ? loadRef.current.gift : null;
          if (current?.status !== "claiming") break;
          const res = await getGiftClient().claimGift(id, token, current.recipientWallet);
          if (res.status === "claimed") {
            polling.current = false;
            void finishClaim(res.gift);
            return;
          }
        } catch {
          // keep trying; the claim is safe server-side
        }
      }
      polling.current = false;
      if (!cancelled) setClaim({ k: "pending", stuck: true });
    })();
    return () => {
      cancelled = true;
      polling.current = false;
    };
  }, [claim, id, token, finishClaim]);

  async function unwrap() {
    // One open at a time: the box stays clickable (aria-disabled) during the animation.
    if (!gift || gift.status !== "wrapped" || unwrapping.current) return;
    // The server clock decides (425 too_early); the local clock only short-circuits
    // when it's clearly early, and a locked box is re-checked on every tap.
    if (gift.opensAt && Date.parse(gift.opensAt) > Date.now() + 60_000) {
      setTooEarly(true);
      return;
    }
    unwrapping.current = true;
    setTooEarly(false);
    setOpenError(null);
    setSheet("unwrapping");
    const minDelay = sleep(reducedMotion() ? REDUCED_MS : UNWRAP_MS);
    try {
      // Show the amount as soon as it's known so it can resolve mid-animation.
      const g = await getGiftClient().openGift(id, token);
      setGift(g);
      await minDelay;
      setSheet("reveal");
    } catch (e) {
      const code = codeOf(e);
      setSheet("box");
      if (code === "too_early") setTooEarly(true);
      else if (code === "invalid_state") void fetchGift();
      else setOpenError(code === "offline" ? "You're offline. Connect and tap the box again." : "Couldn't unwrap it. Try again.");
    } finally {
      unwrapping.current = false;
    }
  }

  async function doClaim() {
    if (claim.k === "sending") return;
    setClaim({ k: "sending" });
    try {
      // A claim in progress is bound to its wallet; retries must reuse it.
      const wallet = gift?.status === "claiming" ? gift.recipientWallet : await getWallet().getAddress();
      const res = await getGiftClient().claimGift(id, token, wallet);
      if (res.status === "claimed") await finishClaim(res.gift);
      else {
        setGift(res.gift);
        setClaim({ k: "pending", stuck: false });
      }
    } catch (e) {
      const code = codeOf(e);
      if (code === "wallet_unavailable") {
        setClaim({
          k: "failed",
          message:
            "This browser couldn't create a wallet. Open your link in an up-to-date browser, outside private mode. Nothing was sent.",
        });
        return;
      }
      if (code === "validation_failed" || code === "invalid_wallet" || code === "unauthorized" || code === "forbidden") {
        setClaim({
          k: "failed",
          message:
            code === "unauthorized" || code === "forbidden"
              ? "This link can't claim the gift. Open the private link you were sent."
              : "That wallet address wasn't accepted. Nothing was sent.",
        });
        return;
      }
      // Anything else (timeout, offline, 409, 5xx) may have happened after the server
      // started the claim, so ask for the real state instead of guessing.
      try {
        const g = await getGiftClient().getGift(id);
        setGift(g);
        if (g.status === "claimed") return finishClaim(g);
        if (g.status === "claiming") return setClaim({ k: "pending", stuck: false });
      } catch {
        // fall through to an honest "unknown" message
      }
      setClaim({
        k: "failed",
        message:
          code === "offline"
            ? "You're offline. Your gift is safe, and it will only ever be sent once."
            : "We couldn't confirm the claim. Your gift is safe and will only be sent once, so it's fine to try again.",
      });
    }
  }

  async function doSwap(ticker: Ticker) {
    const g = await getGiftClient().swapGift(id, token, ticker);
    setGift(g);
  }

  const isRecipient = token.length > 0;

  return (
    <main className="page page--gift">
      <TopBar />
      {offline && (
        <div className="banner" role="status">
          You&rsquo;re offline. We&rsquo;ll reload this gift when you reconnect.
        </div>
      )}

      {load.k === "loading" && <LoadingCard />}
      {load.k === "error" && <LoadError code={load.code} onRetry={fetchGift} />}

      {gift && (
        <section className="thread" aria-label="Gift">
          <p className="thread__who">{isRecipient ? gift.senderName : `To ${gift.recipientName}`}</p>
          {gift.status === "wrapped" ? (
            <WrappedCard
              gift={gift}
              viewer={isRecipient ? "recipient" : "sender"}
              onOpen={isRecipient ? () => setSheet("box") : undefined}
            />
          ) : (
            <OpenedCard gift={gift} />
          )}
          <CardMeta gift={gift} />

          {gift.status === "claimed" && (justClaimed || alreadyClaimed) && (
            <div id="gift-notice" tabIndex={-1} className={`notice ${justClaimed ? "notice--ok" : ""}`} role="status">
              {justClaimed ? (
                <>
                  <strong>Claimed.</strong> ≈ {gift.value.shares} {stockSymbol(gift.ticker)} is in your wallet{" "}
                  {shortAddress(gift.recipientWallet)}.
                </>
              ) : isRecipient ? (
                <>
                  <strong>Already claimed.</strong> This gift went to wallet {shortAddress(gift.recipientWallet)}. A gift can
                  only be claimed once.
                </>
              ) : (
                <>
                  <strong>{gift.recipientName} claimed it.</strong> The tokens are in wallet{" "}
                  {shortAddress(gift.recipientWallet)}.
                </>
              )}
              {isRecipient && (
                <p>
                  <Link href="/w" className="notice__link">
                    See your wallet
                  </Link>
                </p>
              )}
            </div>
          )}
          {!isRecipient && gift.status === "wrapped" && (
            <p className="hint">Only the private link {gift.recipientName} received can unwrap this gift.</p>
          )}
          {isRecipient && gift.status !== "claimed" && sheet === null && gift.status !== "wrapped" && (
            <button type="button" className="btn btn--secondary" onClick={() => setSheet("reveal")} id="show-gift">
              Show gift
            </button>
          )}
          {!isRecipient && (gift.status === "opened" || gift.status === "claiming") && (
            <p className="hint">
              {gift.status === "opened"
                ? `${gift.recipientName} opened it and hasn't claimed it yet.`
                : `It's on its way to ${gift.recipientName}'s wallet.`}
            </p>
          )}
        </section>
      )}

      {gift && sheet !== null && (
        <Sheet fromName={gift.senderName} onClose={closeSheet} labelledBy="sheet-title" returnFocusTo={["gift-notice", "show-gift"]}>
          {(sheet === "box" || sheet === "unwrapping") && (
            <Closed
              gift={gift}
              unwrapping={sheet === "unwrapping"}
              tooEarly={tooEarly}
              error={openError}
              onUnwrap={unwrap}
            />
          )}
          {sheet === "reveal" && gift.status !== "wrapped" && (
            <Reveal gift={gift} claim={claim} onClaim={doClaim} onSwap={doSwap} />
          )}
        </Sheet>
      )}
    </main>
  );
}

function TopBar() {
  return (
    <header className="topbar">
      <Link href="/" className="wordmark">
        Stoked
      </Link>
    </header>
  );
}

function LoadingCard() {
  return (
    <section className="thread" aria-busy="true" aria-label="Loading gift">
      <div className="skeleton skeleton--card" />
      <p className="meta">Loading your gift…</p>
    </section>
  );
}

function LoadError({ code, onRetry }: { code: string; onRetry: () => void }) {
  if (code === "not_found" || code === "bad_request" || code === "validation_failed") {
    return (
      <section className="empty" aria-labelledby="err-title">
        <h1 id="err-title" className="empty__title">
          This gift link doesn&rsquo;t work
        </h1>
        <p className="empty__text">
          It may be incomplete or mistyped. Ask the sender to share the link again, straight from Stoked.
        </p>
        <Link href="/" className="btn btn--secondary">
          Send a stock gift
        </Link>
      </section>
    );
  }
  return (
    <section className="empty" aria-labelledby="err-title">
      <h1 id="err-title" className="empty__title">
        {code === "offline" ? "You’re offline" : "Couldn’t load this gift"}
      </h1>
      <p className="empty__text">
        {code === "offline"
          ? "Your gift is safe. Reconnect and try again."
          : "Something went wrong on our side. Your gift is safe."}
      </p>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

/** 03a and the unwrap animation. */
function Closed({
  gift,
  unwrapping,
  tooEarly,
  error,
  onUnwrap,
}: {
  gift: PublicGift;
  unwrapping: boolean;
  tooEarly: boolean;
  error: string | null;
  onUnwrap: () => void;
}) {
  // tooEarly is reset on each tap, and the server clock has the final say.
  const locked =
    gift.status === "wrapped" && Boolean(gift.opensAt && (tooEarly || Date.parse(gift.opensAt) > Date.now() + 60_000));
  return (
    <div className={`closed ${unwrapping ? "is-unwrapping" : ""}`}>
      <div className="closed__stage">
        <button
          type="button"
          className="closed__box"
          onClick={onUnwrap}
          aria-disabled={locked || unwrapping}
          aria-describedby="closed-sub"
          aria-label={locked ? "Gift box, locked until it opens" : "Unwrap the gift"}
        >
          <GiftBox variant="box" />
        </button>
        {unwrapping && gift.status !== "wrapped" && (
          <span className="closed__amount" aria-hidden="true">
            {formatUsd(gift.usdCents)}
          </span>
        )}
      </div>
      <h2 id="sheet-title" className="closed__title">
        {unwrapping ? "Unwrapping…" : `${gift.senderName} sent you a gift`}
      </h2>
      <p id="closed-sub" className="closed__sub" aria-live="polite">
        {locked && gift.opensAt
          ? `It opens ${formatOpensAt(gift.opensAt)}. Come back then.`
          : unwrapping
            ? "Untying the ribbon"
            : "Tap the box to unwrap it"}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 03b: what's inside, with Claim and Swap. */
function Reveal({
  gift,
  claim,
  onClaim,
  onSwap,
}: {
  gift: Extract<PublicGift, { status: "opened" | "claiming" | "claimed" }>;
  claim: Claim;
  onClaim: () => void;
  onSwap: (t: Ticker) => Promise<void>;
}) {
  const [swapping, setSwapping] = useState(false);
  const swapBtn = useRef<HTMLButtonElement>(null);
  const returnToSwap = useRef(false);
  const closeSwap = () => {
    returnToSwap.current = true;
    setSwapping(false);
  };
  useEffect(() => {
    // Closing the picker unmounts it; put focus back on the button that opened it.
    if (!swapping && returnToSwap.current) {
      returnToSwap.current = false;
      swapBtn.current?.focus();
    }
  }, [swapping]);
  const canAct = gift.status === "opened" && claim.k !== "sending";
  return (
    <div className="reveal">
      <p className="eyebrow">You got</p>
      <h2 id="sheet-title" className="hero">
        {formatUsd(gift.usdCents)} of {stockName(gift.ticker)}
      </h2>
      <p className="shares">
        ≈ {gift.value.shares} shares · {stockSymbol(gift.ticker)}
      </p>
      <ValueLine value={gift.value} giftCents={gift.usdCents} />
      {gift.note && (
        <figure className="note">
          <blockquote className="note__text">{gift.note}</blockquote>
          <figcaption className="note__by">{gift.senderName}</figcaption>
        </figure>
      )}

      {swapping ? (
        <SwapPicker
          current={gift.ticker}
          onCancel={closeSwap}
          onPick={async (t) => {
            await onSwap(t);
            closeSwap();
          }}
        />
      ) : (
        <div className="actions">
          <ClaimStatusPanel claim={claim} onRetry={onClaim} />
          {(claim.k === "idle" || claim.k === "sending") && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={onClaim}
              // Stay focusable while sending (aria-disabled), so focus isn't dropped to <body>.
              disabled={gift.status !== "opened"}
              aria-disabled={claim.k === "sending"}
              aria-busy={claim.k === "sending"}
            >
              {claim.k === "sending" ? "Claiming…" : "Claim to my wallet"}
            </button>
          )}
          {gift.status === "opened" && claim.k !== "pending" && (
            <button
              type="button"
              ref={swapBtn}
              className="btn btn--secondary"
              onClick={() => setSwapping(true)}
              disabled={!canAct}
            >
              Swap for a different stock
            </button>
          )}
        </div>
      )}
      <p className="fine">Tokenized stocks are only offered to eligible people outside the US.</p>
    </div>
  );
}

function ClaimStatusPanel({ claim, onRetry }: { claim: Claim; onRetry: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = claim.k === "pending" ? `pending-${claim.stuck}` : claim.k;
  useEffect(() => {
    // The claim button is replaced by this panel; move focus here so it isn't lost.
    if (ref.current && (key.startsWith("pending") || key === "failed")) ref.current.focus();
  }, [key]);
  if (claim.k === "pending") {
    return (
      <div className="notice" role="status" tabIndex={-1} ref={ref}>
        {claim.stuck ? (
          <>
            <p>
              <strong>Still confirming.</strong> Your gift is safe and will only be sent once.
            </p>
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              Check again
            </button>
          </>
        ) : (
          <p>
            <span className="spinner" aria-hidden="true" /> <strong>Sending to your wallet…</strong> This usually takes a few
            seconds.
          </p>
        )}
      </div>
    );
  }
  if (claim.k === "failed") {
    return (
      <div className="notice notice--error" role="alert" tabIndex={-1} ref={ref}>
        <p>
          <strong>Claim didn&rsquo;t go through.</strong> {claim.message}
        </p>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return null;
}

function SwapPicker({
  current,
  onPick,
  onCancel,
}: {
  current: Ticker;
  onPick: (t: Ticker) => Promise<void>;
  onCancel: () => void;
}) {
  const options = TICKERS.filter((t) => t !== current);
  const [choice, setChoice] = useState<Ticker>(options[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <form
      className="swap"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onPick(choice);
        } catch (err) {
          const code = codeOf(err);
          setError(
            code === "offline"
              ? "You're offline. Your gift hasn't changed."
              : code === "invalid_state"
                ? "This gift can't be swapped any more."
                : "Couldn't swap right now. Your gift hasn't changed.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="swap__set">
        <legend className="label">Swap for the same dollar value of</legend>
        <div className="grid grid--stocks">
          {options.map((t, i) => (
            <label key={t} className="choice choice--stock">
              <input
                type="radio"
                name="swap"
                value={t}
                checked={choice === t}
                onChange={() => setChoice(t)}
                ref={i === 0 ? first : undefined}
              />
              <span className="choice__sym">{stockSymbol(t)}</span>
              <span className="choice__name">{stockName(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? "Swapping…" : `Swap to ${stockName(choice)}`}
      </button>
      <button type="button" className="btn btn--secondary" onClick={onCancel}>
        Keep {stockName(current)}
      </button>
    </form>
  );
}
