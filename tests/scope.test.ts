import { describe, expect, it } from "vitest";
import { isForbiddenPath } from "../src/scope.js";

describe("forbidden path matching", () => {
  it("treats SRC/Services/Link/Session.TS as forbidden", () => {
    expect(isForbiddenPath("SRC/Services/Link/Session.TS")).toBe(true);
  });
});
