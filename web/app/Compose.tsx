"use client";

import {
  CreateGiftRequest,
  GIFT_AMOUNTS_CENTS,
  TICKERS,
  formatUsd,
  type PublicGift,
  type Ticker,
} from "@stoked/shared";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { CardMeta, OpenedCard, WrappedCard } from "@/components/Cards";
import { GiftIcon } from "@/components/icons";
import { GiftClientError, getGiftClient } from "@/lib/client";
import { useGiftPoll } from "@/lib/client/use-gift-poll";
import { stockName, stockSymbol } from "@/lib/format";

type Amount = (typeof GIFT_AMOUNTS_CENTS)[number];
type Sent = { gift: PublicGift; link: string };

/** 01: pick a stock, an amount, a note and when it opens. */
export function Compose() {
  const [recipientName, setRecipient] = useState("");
  const [senderName, setSender] = useState("");
  const [ticker, setTicker] = useState<Ticker>("tNVDA");
  const [amount, setAmount] = useState<Amount>(1000);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [opensAt, setOpensAt] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"recipientName" | "senderName" | "opensAt" | "form", string>>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const ids = { to: useId(), from: useId(), note: useId(), at: useId() };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!recipientName.trim()) next.recipientName = "Add who it's for";
    if (!senderName.trim()) next.senderName = "Add your name";
    let opensIso: string | undefined;
    if (when === "later") {
      const t = Date.parse(opensAt);
      if (!opensAt || Number.isNaN(t)) next.opensAt = "Pick when it opens";
      else if (t <= Date.now()) next.opensAt = "Pick a time in the future";
      else opensIso = new Date(t).toISOString();
    }
    setErrors(next);
    if (Object.keys(next).length) {
      document.getElementById(next.recipientName ? ids.to : next.senderName ? ids.from : ids.at)?.focus();
      return;
    }
    const parsed = CreateGiftRequest.safeParse({
      senderName: senderName.trim(),
      recipientName: recipientName.trim(),
      ticker,
      usdCents: amount,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(opensIso ? { opensAt: opensIso } : {}),
    });
    if (!parsed.success) {
      setErrors({ form: "Something in the form isn't valid. Check the names and note." });
      return;
    }
    setBusy(true);
    try {
      const client = getGiftClient();
      const { id, claimToken } = await client.createGift(parsed.data);
      // The token is returned once, so a failed read must not lose the link.
      const gift = await client.getGift(id).catch(
        (): PublicGift => ({
          id,
          status: "wrapped",
          senderName: parsed.data.senderName,
          recipientName: parsed.data.recipientName,
          opensAt: parsed.data.opensAt ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
      setSent({ gift, link: `${window.location.origin}/g/${id}#t=${claimToken}` });
    } catch (e) {
      const code = e instanceof GiftClientError ? e.code : "internal";
      setErrors({
        form:
          code === "rate_limited"
            ? "Too many gifts from here right now. Wait a minute and try again."
            : code === "offline"
              ? "You're offline. Connect and try again."
              : "Couldn't wrap the gift. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <SentView sent={sent} onAgain={() => setSent(null)} />;

  return (
    <form className="compose" onSubmit={submit} noValidate aria-labelledby="compose-title">
      <div className="compose__head">
        <span className="tile" aria-hidden="true">
          <GiftIcon size={22} />
        </span>
        <h1 id="compose-title" className="compose__brand">
          Stoked
        </h1>
        <span className="compose__tagline">Send a stock gift</span>
      </div>

      <div className="row2">
        <Field id={ids.to} label="To" error={errors.recipientName}>
          <input
            id={ids.to}
            className="input"
            value={recipientName}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Maya"
            maxLength={40}
            autoComplete="off"
            aria-invalid={Boolean(errors.recipientName)}
            aria-describedby={errors.recipientName ? `${ids.to}-err` : undefined}
          />
        </Field>
        <Field id={ids.from} label="From" error={errors.senderName}>
          <input
            id={ids.from}
            className="input"
            value={senderName}
            onChange={(e) => setSender(e.target.value)}
            placeholder="Your name"
            maxLength={40}
            autoComplete="given-name"
            aria-invalid={Boolean(errors.senderName)}
            aria-describedby={errors.senderName ? `${ids.from}-err` : undefined}
          />
        </Field>
      </div>

      <fieldset className="set">
        <legend className="label">Pick a stock</legend>
        <div className="grid grid--stocks">
          {TICKERS.map((t) => (
            <label key={t} className="choice choice--stock">
              <input type="radio" name="ticker" value={t} checked={ticker === t} onChange={() => setTicker(t)} />
              <span className="choice__sym">{stockSymbol(t)}</span>
              <span className="choice__name">{stockName(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="set">
        <legend className="label">Amount</legend>
        <div className="grid grid--amounts">
          {GIFT_AMOUNTS_CENTS.map((c) => (
            <label key={c} className="choice choice--pill">
              <input type="radio" name="amount" value={c} checked={amount === c} onChange={() => setAmount(c)} />
              <span>{formatUsd(c).replace(".00", "")}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="set">
        <label className="label" htmlFor={ids.note}>
          Add a note
        </label>
        <input
          id={ids.note}
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Happy birthday!"
          maxLength={280}
        />
      </div>

      <fieldset className="set">
        <legend className="sr-only">When it opens</legend>
        <div className="segmented">
          <label className="segmented__opt">
            <input type="radio" name="when" value="now" checked={when === "now"} onChange={() => setWhen("now")} />
            <span>Open now</span>
          </label>
          <label className="segmented__opt">
            <input type="radio" name="when" value="later" checked={when === "later"} onChange={() => setWhen("later")} />
            <span>Pick a time</span>
          </label>
        </div>
        {when === "later" && (
          <Field id={ids.at} label="Opens at" error={errors.opensAt}>
            <input
              id={ids.at}
              className="input"
              type="datetime-local"
              value={opensAt}
              onChange={(e) => setOpensAt(e.target.value)}
              aria-invalid={Boolean(errors.opensAt)}
              aria-describedby={errors.opensAt ? `${ids.at}-err` : undefined}
            />
          </Field>
        )}
      </fieldset>

      {errors.form && (
        <p className="error" role="alert">
          {errors.form}
        </p>
      )}
      <button type="submit" className="btn btn--primary btn--wrap" disabled={busy} aria-busy={busy}>
        <GiftIcon className="btn__icon" />
        {busy ? "Wrapping…" : `Wrap ${formatUsd(amount).replace(".00", "")} of ${stockName(ticker)}`}
      </button>
    </form>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-err`} className="error">
          {error}
        </p>
      )}
    </div>
  );
}

function SentView({ sent, onAgain }: { sent: Sent; onAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const linkId = useId();
  const path = new URL(sent.link).pathname + new URL(sent.link).hash;
  // The sender's card follows the gift as the recipient opens and claims it.
  const [gift, setGift] = useState(sent.gift);
  useGiftPoll(gift, setGift);
  const name = gift.recipientName;
  // Once claimed the private link is spent, so stop offering it.
  const claimed = gift.status === "claimed";
  const status =
    gift.status === "opened"
      ? `${name} opened it and hasn't claimed it yet.`
      : gift.status === "claiming"
        ? `It's on its way to ${name}'s wallet.`
        : gift.status === "claimed"
          ? `${name} claimed it.`
          : "";
  return (
    <section className="sent" aria-labelledby="sent-title">
      <h1 id="sent-title" className="sent__title">
        Wrapped for {sent.gift.recipientName}
      </h1>
      {!claimed && (
        <p className="sent__text">
          Send {sent.gift.recipientName} this private link. Anyone with it can unwrap the gift, so share it only with them.
        </p>
      )}
      {gift.status === "wrapped" ? (
        <WrappedCard gift={gift} viewer="sender" />
      ) : (
        <div>
          <OpenedCard gift={gift} />
          <CardMeta gift={gift} />
        </div>
      )}
      <p className="sent__status" role="status">
        {status}
      </p>
      {!claimed && (
        <>
          <div className="field">
            <label className="label" htmlFor={linkId}>
              Private gift link
            </label>
            <div className="copy">
              <input id={linkId} className="input copy__input" readOnly value={sent.link} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="btn btn--secondary copy__btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(sent.link);
                    setCopied(true);
                  } catch {
                    document.getElementById(linkId)?.focus();
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <Link href={path} className="btn btn--primary">
            Open it as {sent.gift.recipientName}
          </Link>
        </>
      )}
      <button type="button" className={`btn ${claimed ? "btn--primary" : "btn--secondary"}`} onClick={onAgain}>
        Send another
      </button>
      <span role="status" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
    </section>
  );
}
