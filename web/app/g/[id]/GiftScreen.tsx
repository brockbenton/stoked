"use client";

import { formatUsd, TICKERS, type PublicGift, type Ticker } from "@stoked/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardMeta, OpenedCard, WrappedCard } from "@/components/Cards";
import { DevnetLabel } from "@/components/DevnetLabel";
import { GiftBox } from "@/components/GiftBox";
import { Sheet } from "@/components/Sheet";
import { ValueLine } from "@/components/ValueLine";
import { GiftClientError, getGiftClient, getWallet, readTokenFromHash } from "@/lib/client";
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
  const [now, setNow] = useState(() => Date.now());
  const polling = useRef(false);

  const gift = load.k === "ready" ? load.gift : null;
  const setGift = (g: PublicGift) => setLoad({ k: "ready", gift: g });

  const fetchGift = useCallback(async () => {
    setLoad({ k: "loading" });
    try {
      const g = await getGiftClient().getGift(id);
      setLoad({ k: "ready", gift: g });
      setNow(Date.now());
      if (g.status === "opened") setSheet("reveal");
      if (g.status === "claiming") {
        setSheet("reveal");
        setClaim({ k: "pending", stuck: false });
      }
      if (g.status === "claimed") setAlreadyClaimed(true);
    } catch (e) {
      setLoad({ k: "error", code: codeOf(e) });
    }
  }, [id]);

  useEffect(() => {
    setToken(readTokenFromHash(window.location.hash));
    setOffline(!navigator.onLine);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void fetchGift();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [fetchGift]);

  const finishClaim = useCallback((g: PublicGift) => {
    setGift(g);
    setClaim({ k: "idle" });
    setSheet(null);
    setJustClaimed(true);
  }, []);

  /** Poll while a claim is pending; flag it as stuck (retryable) after a while. */
  useEffect(() => {
    if (claim.k !== "pending" || claim.stuck || polling.current) return;
    polling.current = true;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < POLLS_BEFORE_STUCK && !cancelled; i++) {
        await sleep(POLL_MS);
        if (cancelled) break;
        try {
          const g = await getGiftClient().getGift(id);
          if (g.status === "claimed") {
            finishClaim(g);
            polling.current = false;
            return;
          }
        } catch {
          // keep polling; the claim is safe server-side
        }
      }
      polling.current = false;
      if (!cancelled) setClaim({ k: "pending", stuck: true });
    })();
    return () => {
      cancelled = true;
      polling.current = false;
    };
  }, [claim, id, finishClaim]);

  async function unwrap() {
    if (!gift || gift.status !== "wrapped") return;
    if (gift.opensAt && Date.parse(gift.opensAt) > Date.now()) {
      setTooEarly(true);
      return;
    }
    setOpenError(null);
    setSheet("unwrapping");
    const minDelay = sleep(reducedMotion() ? REDUCED_MS : UNWRAP_MS);
    try {
      // Show the amount as soon as it's known so it can resolve mid-animation.
      const g = await getGiftClient().openGift(id, token);
      setGift(g);
      setNow(Date.now());
      await minDelay;
      setSheet("reveal");
    } catch (e) {
      const code = codeOf(e);
      setSheet("box");
      if (code === "too_early") setTooEarly(true);
      else if (code === "invalid_state") void fetchGift();
      else setOpenError(code === "offline" ? "You're offline. Connect and tap the box again." : "Couldn't unwrap it. Try again.");
    }
  }

  async function doClaim() {
    setClaim({ k: "sending" });
    try {
      const wallet = await getWallet().getAddress();
      const res = await getGiftClient().claimGift(id, token, wallet);
      if (res.status === "claimed") finishClaim(res.gift);
      else {
        setGift(res.gift);
        setClaim({ k: "pending", stuck: false });
      }
    } catch (e) {
      const code = codeOf(e);
      setClaim({
        k: "failed",
        message:
          code === "offline"
            ? "You're offline, so nothing was sent. Your gift is still here."
            : "Devnet didn’t accept the transfer. Nothing left the gift, so you can try again.",
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
          You&rsquo;re offline. We&rsquo;ll pick up where you left off when you reconnect.
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
            <OpenedCard gift={gift} now={now} />
          )}
          <CardMeta gift={gift} />

          {gift.status === "claimed" && (justClaimed || alreadyClaimed) && (
            <div className={`notice ${justClaimed ? "notice--ok" : ""}`} role="status">
              {justClaimed ? (
                <>
                  <strong>Claimed.</strong> {gift.value.shares} {gift.ticker} devnet test tokens are in your wallet{" "}
                  {shortAddress(gift.recipientWallet)}.
                </>
              ) : (
                <>
                  <strong>Already claimed.</strong> This gift went to wallet {shortAddress(gift.recipientWallet)}. A gift can
                  only be claimed once.
                </>
              )}
            </div>
          )}
          {!isRecipient && gift.status === "wrapped" && (
            <p className="hint">Only the private link {gift.recipientName} received can unwrap this gift.</p>
          )}
          {isRecipient && gift.status !== "claimed" && sheet === null && gift.status !== "wrapped" && (
            <button type="button" className="btn btn--secondary" onClick={() => setSheet("reveal")}>
              Show gift
            </button>
          )}
        </section>
      )}

      {gift && sheet !== null && (
        <Sheet fromName={gift.senderName} onClose={() => setSheet(null)} labelledBy="sheet-title">
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
            <Reveal gift={gift} now={now} claim={claim} onClaim={doClaim} onSwap={doSwap} />
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
      <DevnetLabel />
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
  const locked =
    gift.status === "wrapped" && Boolean(gift.opensAt && (tooEarly || Date.parse(gift.opensAt) > Date.now()));
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
  now,
  claim,
  onClaim,
  onSwap,
}: {
  gift: Extract<PublicGift, { status: "opened" | "claiming" | "claimed" }>;
  now: number;
  claim: Claim;
  onClaim: () => void;
  onSwap: (t: Ticker) => Promise<void>;
}) {
  const [swapping, setSwapping] = useState(false);
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
      <ValueLine value={gift.value} now={now} extra="updates in the chat" />
      {gift.note && (
        <figure className="note">
          <blockquote className="note__text">{gift.note}</blockquote>
          <figcaption className="note__by">{gift.senderName}</figcaption>
        </figure>
      )}
      <div className="reveal__tag">
        <DevnetLabel />
      </div>

      {swapping ? (
        <SwapPicker
          current={gift.ticker}
          onCancel={() => setSwapping(false)}
          onPick={async (t) => {
            await onSwap(t);
            setSwapping(false);
          }}
        />
      ) : (
        <div className="actions">
          <ClaimStatusPanel claim={claim} onRetry={onClaim} />
          {(claim.k === "idle" || claim.k === "sending") && (
            <button type="button" className="btn btn--primary" onClick={onClaim} disabled={!canAct} aria-busy={claim.k === "sending"}>
              {claim.k === "sending" ? "Claiming…" : "Claim to my wallet"}
            </button>
          )}
          {gift.status === "opened" && claim.k !== "pending" && (
            <button type="button" className="btn btn--secondary" onClick={() => setSwapping(true)} disabled={!canAct}>
              Swap for a different stock
            </button>
          )}
          <p className="fine">Tokenized stocks are only offered to eligible people outside the US.</p>
        </div>
      )}
    </div>
  );
}

function ClaimStatusPanel({ claim, onRetry }: { claim: Claim; onRetry: () => void }) {
  if (claim.k === "pending") {
    return (
      <div className="notice" role="status">
        {claim.stuck ? (
          <>
            <p>
              <strong>Still confirming on devnet.</strong> Your gift is safe and will only be sent once.
            </p>
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              Check again
            </button>
          </>
        ) : (
          <p>
            <span className="spinner" aria-hidden="true" /> <strong>Sending to your wallet…</strong> This usually takes a few
            seconds on devnet.
          </p>
        )}
      </div>
    );
  }
  if (claim.k === "failed") {
    return (
      <div className="notice notice--error" role="alert">
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
  return (
    <form
      className="swap"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onPick(choice);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="swap__set">
        <legend className="label">Swap for the same dollar value of</legend>
        <div className="grid grid--stocks">
          {options.map((t) => (
            <label key={t} className="choice choice--stock">
              <input type="radio" name="swap" value={t} checked={choice === t} onChange={() => setChoice(t)} />
              <span className="choice__sym">{stockSymbol(t)}</span>
              <span className="choice__name">{stockName(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? "Swapping…" : `Swap to ${stockName(choice)}`}
      </button>
      <button type="button" className="btn btn--secondary" onClick={onCancel}>
        Keep {stockName(current)}
      </button>
    </form>
  );
}
