import { GIFT_AMOUNTS_CENTS, formatUsd } from "@stoked/shared";

// Placeholder until G2 builds the compose screen.
export default function Home() {
  return (
    <main>
      <h1>Stoked</h1>
      <p>Scaffold only. Gifts of {GIFT_AMOUNTS_CENTS.map(formatUsd).join(", ")} in devnet test tokens are coming.</p>
    </main>
  );
}
