import { describe, expect, it } from "vitest";
import { createStubChain, NotImplementedError } from "../src/index";

describe("chain stub", () => {
  it("refuses every call without touching a cluster", async () => {
    const chain = createStubChain();
    await expect(chain.multiplierSchedule("tNVDA")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(chain.claimStatus("sig", 1n)).rejects.toBeInstanceOf(NotImplementedError);
  });
});
