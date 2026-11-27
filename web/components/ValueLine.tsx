import { formatUsd, type GiftValue } from "@stoked/shared";

/** "Value $15.00", only once the value differs from the amount already shown above it. */
export function ValueLine({ value, giftCents }: { value: GiftValue; giftCents: number }) {
  if (value.valueCents === giftCents) return null;
  return <p className="value">Value {formatUsd(value.valueCents)}</p>;
}
