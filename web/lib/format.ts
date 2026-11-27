import { UNDERLYING, type Ticker } from "@stoked/shared";

export const stockName = (t: Ticker) => UNDERLYING[t].name;
export const stockSymbol = (t: Ticker) => UNDERLYING[t].symbol;

export function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}

const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const longDate = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const formatTime = (iso: string) => time.format(new Date(iso));
export const formatOpensAt = (iso: string) => longDate.format(new Date(iso));

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
