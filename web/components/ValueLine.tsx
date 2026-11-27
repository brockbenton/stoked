import { formatUsd, type GiftValue } from "@stoked/shared";

/** "Value $10.00" */
export function ValueLine({ value }: { value: GiftValue }) {
  return (
    <p className="value">
      <span className="value__dot" aria-hidden="true" />
      <span>Value {formatUsd(value.valueCents)}</span>
    </p>
  );
}
