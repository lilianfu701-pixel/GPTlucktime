import type { RecoveredMessage } from "./realtime-client";

type ReceiptKind = "delivered" | "read";
type ReceiptResult = { ok: true } | {
  ok: false;
  code: "RETRY_LATER" | "NOT_AVAILABLE";
  retryAfterMs?: number;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const parseRetryAfter = (value: string | null, now = Date.now()) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(trimmed)
    ? Math.round(Number(trimmed) * 1_000)
    : Date.parse(trimmed) - now;
  return Number.isFinite(milliseconds) ? Math.min(Math.max(milliseconds, 0), 60_000) : undefined;
};

export function createHttpReceiptSender(fetcher: Fetcher = fetch): (
  kind: ReceiptKind,
  message: RecoveredMessage,
  at: string,
  signal: AbortSignal,
) => Promise<ReceiptResult> {
  return async (kind, message, at, signal) => {
    try {
      const response = await fetcher(`/api/v1/conversations/${encodeURIComponent(message.conversationId)}/receipts`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: message.id, kind, at }),
        signal,
      });
      if (response.ok) return { ok: true };
      if ([401, 403, 404].includes(response.status)) return { ok: false, code: "NOT_AVAILABLE" };
      if (response.status === 429 || response.status >= 500) {
        return { ok: false, code: "RETRY_LATER", retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) };
      }
      return { ok: false, code: "NOT_AVAILABLE" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, code: "RETRY_LATER" };
    }
  };
}
