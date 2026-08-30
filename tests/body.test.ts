import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readTextLimited } from "../src/body.js";

describe("readTextLimited", () => {
  it("rejects a declared Content-Length over the cap without reading", async () => {
    let pulls = 0;
    const request = new Request("http://localhost/v1/evidence", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: new ReadableStream<Uint8Array>({
        pull() {
          pulls += 1;
        },
      }),
      duplex: "half",
    } as RequestInit);
    const result = await Promise.race([
      readTextLimited(request),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("content-length reject hung")), 1000);
      }),
    ]);
    expect(result).toEqual({ ok: false });
    expect(pulls).toBe(0);
  });

  it("aborts once the streamed body exceeds the cap", async () => {
    const request = new Request("http://localhost/v1/evidence", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
        },
        pull() {
          // further reads would hang
        },
      }),
      duplex: "half",
    } as RequestInit);
    const result = await Promise.race([
      readTextLimited(request),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("stream abort hung")), 1000);
      }),
    ]);
    expect(result).toEqual({ ok: false });
  });
});
