import { formatUsd, type GiftValue } from "@stoked/shared";
import { formatDateTime, isLivePrice } from "@/lib/format";

/** "Value $10.00 · Demo price (not live), Nov 28, 2:55 PM". Never a price without source and age. */
export function ValueLine({ value, now, extra }: { value: GiftValue; now: number; extra?: string }) {
  const live = isLivePrice(value, now);
  return (
    <p className="value">
      <span className="value__dot" aria-hidden="true" />
      <span>
        {live ? "Live value" : "Value"} {formatUsd(value.valueCents)}
        {extra ? ` · ${extra}` : ""}
        <span className="value__src">
          {value.priceSource}, {formatDateTime(value.priceUpdatedAt)}
        </span>
      </span>
    </p>
  );
}
