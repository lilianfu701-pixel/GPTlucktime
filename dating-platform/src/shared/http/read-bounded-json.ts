export class BoundedJsonError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
    super(code);
  }
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) {
    throw new BoundedJsonError("UNSUPPORTED_MEDIA_TYPE");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new BoundedJsonError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw new BoundedJsonError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BoundedJsonError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof BoundedJsonError) throw error;
    throw new BoundedJsonError("INVALID_REQUEST");
  }
}
