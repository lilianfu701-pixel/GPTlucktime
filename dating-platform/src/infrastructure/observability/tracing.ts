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

const STABLE_VALUE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const TELEMETRY_NAME = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)*$/u;
const ROUTE_SEGMENT = String.raw`(?:[A-Za-z][A-Za-z0-9._~-]*|\[[A-Za-z][A-Za-z0-9]*\])`;
const ROUTE_TEMPLATE = new RegExp(String.raw`^(?:/|/${ROUTE_SEGMENT}(?:/${ROUTE_SEGMENT})*)$`, "u");
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const ROUTE_TYPES = new Set(["action", "proxy", "render", "route"]);
const ROUTER_KINDS = new Set(["App Router", "Pages Router"]);
const RUNTIMES = new Set(["edge", "nodejs"]);
const SAFE_ERROR_NAMES = new Set([
  "AggregateError", "AppError", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);
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
    if (key === "route" && typeof value === "string" && value.length <= 160 && ROUTE_TEMPLATE.test(value)) {
      safe[key] = value;
    } else if (key === "method" && typeof value === "string" && HTTP_METHODS.has(value)) {
      safe[key] = value;
    } else if (key === "routeType" && typeof value === "string" && ROUTE_TYPES.has(value)) {
      safe[key] = value;
    } else if (key === "routerKind" && typeof value === "string" && ROUTER_KINDS.has(value)) {
      safe[key] = value;
    } else if (key === "runtime" && typeof value === "string" && RUNTIMES.has(value)) {
      safe[key] = value;
    } else if (key === "countryCode" && typeof value === "string" && /^[A-Z]{2}$/u.test(value)) {
      safe[key] = value;
    } else if (key === "statusCode" && typeof value === "number" && Number.isInteger(value)
      && value >= 100 && value <= 599) {
      safe[key] = value;
    } else if (key === "retryable" && typeof value === "boolean") {
      safe[key] = value;
    } else if (["event", "mediaType", "moderationType", "operation", "outcome", "provider", "queue", "reason", "region", "service", "status"]
      .includes(key) && typeof value === "string" && STABLE_VALUE.test(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
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
    span.recordException?.({ errorName: safeErrorName(error) });
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
    span.recordException?.({ errorName: safeErrorName(error) });
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
  if (!TELEMETRY_NAME.test(name)) throw new TypeError("METRIC_NAME_INVALID");
  const dimensions = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => METRIC_ATTRIBUTE_KEYS.has(key)),
  );
  sink.recordMetric(name, value, sanitizeTelemetryAttributes(dimensions));
}
