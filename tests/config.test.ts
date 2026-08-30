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

  it("defaults ingestOrigins to the Hypercolor web origin when unset", () => {
    expect(loadConfig(tokens).ingestOrigins).toEqual(["https://hypercolor-web.vercel.app"]);
  });

  it("parses a trimmed comma-separated exact origin list", () => {
    expect(
      loadConfig({
        ...tokens,
        VIBEWARE_INGEST_ORIGINS: " https://a.example , http://localhost:3000 ",
      }).ingestOrigins,
    ).toEqual(["https://a.example", "http://localhost:3000"]);
  });

  it("rejects a wildcard VIBEWARE_INGEST_ORIGINS list", () => {
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "*" })).toThrow(/VIBEWARE_INGEST_ORIGINS/);
  });

  it("rejects a path-like VIBEWARE_INGEST_ORIGINS value", () => {
    expect(() =>
      loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://hypercolor-web.vercel.app/ingest" }),
    ).toThrow(/VIBEWARE_INGEST_ORIGINS/);
  });

  it("rejects query strings, credentials, and null ingest origins", () => {
    expect(() =>
      loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://hypercolor-web.vercel.app?next=1" }),
    ).toThrow(/VIBEWARE_INGEST_ORIGINS/);
    expect(() =>
      loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://user:pass@hypercolor-web.vercel.app" }),
    ).toThrow(/VIBEWARE_INGEST_ORIGINS/);
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "null" })).toThrow(/VIBEWARE_INGEST_ORIGINS/);
  });

  it("rejects empty, whitespace-only, trailing-comma, and trailing-slash ingest origins", () => {
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "" })).toThrow(/VIBEWARE_INGEST_ORIGINS/);
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://a.example,  " })).toThrow(
      /VIBEWARE_INGEST_ORIGINS/,
    );
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://a.example," })).toThrow(
      /VIBEWARE_INGEST_ORIGINS/,
    );
    expect(() => loadConfig({ ...tokens, VIBEWARE_INGEST_ORIGINS: "https://a.example/" })).toThrow(
      /VIBEWARE_INGEST_ORIGINS/,
    );
  });
});
