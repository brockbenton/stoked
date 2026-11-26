/**
 * Change a mint's Scaled UI Amount multiplier, e.g. to demonstrate a dividend:
 *   pnpm --filter @stoked/chain multiplier tNVDA 1.002 [effectiveUnixSeconds]
 */
import { Ticker } from "@stoked/shared";
import { chainConfigFromEnv, getMultiplierSchedule, updateMultiplier } from "../index";
import { loadEnv } from "./env";

const [tickerArg, multiplierArg, tsArg] = process.argv.slice(2);
const ticker = Ticker.safeParse(tickerArg);
const multiplier = Number(multiplierArg);
if (!ticker.success || !(multiplier > 0)) {
  console.error("usage: multiplier <tNVDA|tAAPL|tSPY|tTSLA|tCOST> <multiplier> [effectiveUnixSeconds]");
  process.exit(2);
}
loadEnv();
const { connection, treasury, mints } = chainConfigFromEnv();
const mint = mints![ticker.data];
const sig = await updateMultiplier({
  connection,
  treasury,
  mint,
  multiplier,
  ...(tsArg ? { effectiveTimestamp: BigInt(tsArg) } : {}),
});
console.log(`${ticker.data} multiplier update: ${sig}`);
console.log(await getMultiplierSchedule(connection, mint));
