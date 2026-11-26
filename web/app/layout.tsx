import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-grotesk", display: "swap" });

export const metadata: Metadata = {
  // Absolute URLs for link previews. Unset, Next uses the deployment URL.
  metadataBase: process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN) : undefined,
  title: "Stoked",
  description: "Gift a slice of a stock in a conversation. Devnet test tokens only.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#12372A",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
}
