export const SPAN_NAMES = {
  http: "http.request",
  database: "database.query",
  queue: "queue.process",
  realtime: "realtime.event",
  payment: "payment.operation",
  media: "media.operation",
  moderation: "moderation.operation",
} as const;

export type SpanCategory = keyof typeof SPAN_NAMES;
export type TelemetryAttribute = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttribute>>;

export type SpanHandle = {
  end(): void;
  recordException?(error: unknown): void;
};

export type ObservabilitySink = {
  startSpan(name: string, attributes: TelemetryAttributes): SpanHandle;
  recordMetric(name: string, value: number, attributes: TelemetryAttributes): void;
};

const noopSpan: SpanHandle = { end: () => undefined };
const noopSink: ObservabilitySink = {
  startSpan: () => noopSpan,
  recordMetric: () => undefined,
};
let sink: ObservabilitySink = noopSink;

const PRIVATE_ATTRIBUTE = /^(?:address|authorization|body|content|cookie|email|exactLocation|lat|latitude|lng|location|longitude|message|messageText|password|phone|secret|text|token)$/iu;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_VALUE = /^\+?\d[\d\s().-]{7,}$/u;
const METRIC_ATTRIBUTE_KEYS = new Set([
  "countryCode",
  "event",
  "mediaType",
  "method",
  "moderationType",
  "operation",
  "outcome",
  "provider",
  "queue",
  "reason",
  "region",
  "route",
  "routeType",
  "runtime",
  "service",
  "status",
  "statusCode",
]);

export function sanitizeTelemetryAttributes(
  attributes: Readonly<Record<string, unknown>> = {},
): TelemetryAttributes {
  const safe: Record<string, TelemetryAttribute> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (PRIVATE_ATTRIBUTE.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value === "string" && (EMAIL_VALUE.test(value) || PHONE_VALUE.test(value))) continue;
    safe[key] = value;
  }
  return safe;
}

export function configureObservability(next?: Partial<ObservabilitySink>): void {
  sink = next
    ? {
        startSpan: next.startSpan ?? noopSink.startSpan,
        recordMetric: next.recordMetric ?? noopSink.recordMetric,
      }
    : noopSink;
}

export function startSpan(
  category: SpanCategory,
  operation: string,
  attributes: Readonly<Record<string, unknown>> = {},
): SpanHandle {
  return sink.startSpan(SPAN_NAMES[category], sanitizeTelemetryAttributes({ operation, ...attributes }));
}

export async function withSpan<T>(
  category: SpanCategory,
  operation: string,
  attributes: Readonly<Record<string, unknown>>,
  task: () => T | Promise<T>,
): Promise<T> {
  const span = startSpan(category, operation, attributes);
  try {
    return await task();
  } catch (error) {
    span.recordException?.({ errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  } finally {
    span.end();
  }
}

export function captureException(
  category: SpanCategory,
  operation: string,
  error: unknown,
  attributes: Readonly<Record<string, unknown>> = {},
): void {
  const span = startSpan(category, operation, attributes);
  try {
    span.recordException?.({ errorName: error instanceof Error ? error.name : "UnknownError" });
  } finally {
    span.end();
  }
}

export function recordMetric(
  name: string,
  value: number,
  attributes: Readonly<Record<string, unknown>> = {},
): void {
  if (!Number.isFinite(value)) throw new TypeError("METRIC_VALUE_INVALID");
  const dimensions = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => METRIC_ATTRIBUTE_KEYS.has(key)),
  );
  sink.recordMetric(name, value, sanitizeTelemetryAttributes(dimensions));
}
