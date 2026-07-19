import type { BirthInput } from "../core/types";

export const MAX_CHART_PAYLOAD_LENGTH = 8_192;

interface ChartPayloadEnvelope {
  readonly version: 1;
  readonly input: BirthInput;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(payload: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeChartPayload(input: BirthInput): string {
  const envelope: ChartPayloadEnvelope = { version: 1, input };
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
  if (payload.length > MAX_CHART_PAYLOAD_LENGTH) {
    throw new RangeError("Chart payload exceeds the supported length.");
  }
  return payload;
}

export function decodeChartPayload(payload: string): BirthInput | null {
  if (payload.length === 0 || payload.length > MAX_CHART_PAYLOAD_LENGTH) {
    return null;
  }
  const bytes = base64UrlToBytes(payload);
  if (!bytes) return null;

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      (parsed as { input?: unknown }).input === null ||
      typeof (parsed as { input?: unknown }).input !== "object"
    ) {
      return null;
    }
    return (parsed as ChartPayloadEnvelope).input;
  } catch {
    return null;
  }
}
