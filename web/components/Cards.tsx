import { formatUsd, type PublicGift } from "@stoked/shared";
import { explorerTxUrl, formatTime, stockName, stockSymbol } from "@/lib/format";
import { GiftBox } from "./GiftBox";
import { ChevronRight, GiftIcon } from "./icons";
import { ValueLine } from "./ValueLine";

type Opened = Extract<PublicGift, { status: "opened" | "claiming" | "claimed" }>;

/** 02: the wrapped card as it sits in the conversation. */
export function WrappedCard({
  gift,
  viewer,
  onOpen,
}: {
  gift: PublicGift;
  viewer: "recipient" | "sender";
  onOpen?: () => void;
}) {
  const title = viewer === "recipient" ? `${gift.senderName} sent you a gift` : `You sent ${gift.recipientName} a gift`;
  const sub = viewer === "recipient" ? "Tap to unwrap" : `Waiting for ${gift.recipientName} to unwrap`;
  const body = (
    <>
      <div className="wcard__art">
        <GiftBox variant="card" />
        <span className="wcard__pill">A stock gift inside</span>
      </div>
      <div className="wcard__foot">
        <span className="wcard__text">
          <span className="wcard__title">{title}</span>
          <span className="wcard__sub">{sub}</span>
        </span>
        {onOpen && (
          <span className="wcard__chev">
            <ChevronRight />
          </span>
        )}
      </div>
    </>
  );
  return onOpen ? (
    <button type="button" className="wcard" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="wcard">{body}</div>
  );
}

/** 04: the card after opening; "claimed" once the tokens are in the wallet. */
export function OpenedCard({ gift, now }: { gift: Opened; now: number }) {
  const where =
    gift.status === "claimed"
      ? `in ${gift.recipientName}'s wallet`
      : gift.status === "claiming"
        ? `on its way to ${gift.recipientName}'s wallet`
        : "not claimed yet";
  return (
    <article className="ocard" aria-label={`Gift from ${gift.senderName}`}>
      <header className="ocard__head">
        <GiftIcon className="ocard__icon" />
        <span className="ocard__from">Gift from {gift.senderName}</span>
        <span className="badge">Opened</span>
      </header>
      <div className="ocard__body">
        <p className="ocard__amount">
          {formatUsd(gift.usdCents)} of {stockName(gift.ticker)}
        </p>
        <p className="ocard__shares">
          ≈ {gift.value.shares} {stockSymbol(gift.ticker)} · {where}
        </p>
        <ValueLine value={gift.value} now={now} />
      </div>
    </article>
  );
}

export function CardMeta({ gift }: { gift: PublicGift }) {
  if (gift.status === "claimed") {
    return (
      <p className="meta">
        Stoked · claimed {formatTime(gift.claimedAt)} ·{" "}
        <a className="meta__link" href={explorerTxUrl(gift.claimSignature)} target="_blank" rel="noreferrer">
          View on devnet explorer
        </a>
      </p>
    );
  }
  return <p className="meta">Stoked</p>;
}
