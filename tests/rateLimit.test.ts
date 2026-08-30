import { describe, expect, it } from "vitest";
import { createFailureLimiter } from "../src/rateLimit.js";

describe("createFailureLimiter", () => {
  it("evicts the oldest key when the map exceeds maxEntries", () => {
    const limiter = createFailureLimiter({ max: 5, windowMs: 60_000, maxEntries: 2 });
    limiter.recordFailure("oldest");
    limiter.recordFailure("kept");
    limiter.recordFailure("newest");
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure("kept");
    }
    expect(limiter.isLimited("kept")).toBe(true);
    expect(limiter.isLimited("oldest")).toBe(false);
    expect(limiter.isLimited("newest")).toBe(false);
  });

  it("does not keep an empty bucket after the window elapses", async () => {
    const limiter = createFailureLimiter({ max: 3, windowMs: 15, maxEntries: 8 });
    limiter.recordFailure("gone");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(limiter.isLimited("gone")).toBe(false);
    limiter.recordFailure("other-a");
    limiter.recordFailure("other-b");
    limiter.recordFailure("other-c");
    expect(limiter.isLimited("gone")).toBe(false);
  });
});
