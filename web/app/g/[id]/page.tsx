import type { Metadata } from "next";
import { GiftScreen } from "./GiftScreen";

export const metadata: Metadata = {
  title: "You got a gift · Stoked",
  // Never describe what's inside: previews and crawlers see only this.
  description: "Someone sent you a gift. Open the link to unwrap it.",
};

export default async function GiftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GiftScreen id={id} />;
}
