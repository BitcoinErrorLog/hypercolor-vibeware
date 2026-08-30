import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const tokens = {
  VIBEWARE_INGEST_TOKEN: "ingest-token-16chars",
  VIBEWARE_DASHBOARD_TOKEN: "dashboard-token-16",
  VIBEWARE_INTERNAL_TOKEN: "internal-token-16c",
};

describe("loadConfig", () => {
  it("fails closed without VIBEWARE_INTERNAL_TOKEN", () => {
    expect(() =>
      loadConfig({
        VIBEWARE_INGEST_TOKEN: tokens.VIBEWARE_INGEST_TOKEN,
        VIBEWARE_DASHBOARD_TOKEN: tokens.VIBEWARE_DASHBOARD_TOKEN,
      }),
    ).toThrow(/VIBEWARE_INTERNAL_TOKEN/);
  });

  it("keeps query-token login off unless explicitly true", () => {
    const config = loadConfig(tokens);
    expect(config.allowQueryTokenLogin).toBe(false);
    expect(loadConfig({ ...tokens, VIBEWARE_ALLOW_QUERY_TOKEN_LOGIN: "true" }).allowQueryTokenLogin).toBe(
      true,
    );
  });

  it("fails boot when dashboard and internal tokens are identical", () => {
    expect(() =>
      loadConfig({
        ...tokens,
        VIBEWARE_DASHBOARD_TOKEN: tokens.VIBEWARE_INTERNAL_TOKEN,
      }),
    ).toThrow(/VIBEWARE_DASHBOARD_TOKEN and VIBEWARE_INTERNAL_TOKEN must be distinct/);
  });
});
