export const MAX_BODY_BYTES = 8192;

export type LimitedText = { ok: true; text: string } | { ok: false };

function contentLengthBytes(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null || raw === "") return undefined;
  const length = Number(raw.trim());
  if (!Number.isInteger(length) || length < 0) return undefined;
  return length;
}

function decodeUtf8(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function readTextLimited(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<LimitedText> {
  const declared = contentLengthBytes(request);
  if (declared !== undefined && declared > maxBytes) {
    if (request.body) {
      await request.body.cancel();
    }
    return { ok: false };
  }

  if (request.body === null) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: decodeUtf8(chunks) };
}
