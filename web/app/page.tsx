import type { Metadata } from "next";
import { Compose } from "./Compose";

// Set here, not in the layout, so gift pages don't inherit this title in their previews.
export const metadata: Metadata = {
  openGraph: {
    type: "website",
    siteName: "Stoked",
    title: "Stoked",
    description: "Gift a slice of a stock in a conversation.",
  },
};

export default function Home() {
  return (
    <main className="page page--compose">
      <Compose />
    </main>
  );
}
