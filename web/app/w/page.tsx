import type { Metadata } from "next";
import { WalletScreen } from "./WalletScreen";

export const metadata: Metadata = { title: "Your wallet · Stoked" };

export default function WalletPage() {
  return <WalletScreen />;
}
