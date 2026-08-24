import { AppError, type FieldErrors } from "./app-error";

export type ErrorResponseBody = {
  code: string;
  messageKey: string;
  retryable: boolean;
  traceId: string;
  fieldErrors?: FieldErrors;
};

export type ErrorResponse = {
  status: number;
  body: ErrorResponseBody;
};

export type StructuredErrorLogger = {
  error(event: "application_error", context: Readonly<Record<string, unknown>>): void;
};

type ErrorResponseOptions = {
  logger?: StructuredErrorLogger;
};

const STABLE_VALUE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const ROUTE_SEGMENT = String.raw`(?:[A-Za-z][A-Za-z0-9._~-]*|\[[A-Za-z][A-Za-z0-9]*\])`;
const ROUTE_TEMPLATE = new RegExp(String.raw`^(?:/|/${ROUTE_SEGMENT}(?:/${ROUTE_SEGMENT})*)$`, "u");
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const SAFE_ERROR_NAMES = new Set([
  "AggregateError", "AppError", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);

function safeContextValue(key: string, value: unknown): string | number | boolean | undefined {
  if (key === "route") return typeof value === "string" && value.length <= 160 && ROUTE_TEMPLATE.test(value)
    ? value : undefined;
  if (key === "method") return typeof value === "string" && HTTP_METHODS.has(value) ? value : undefined;
  if (key === "countryCode") return typeof value === "string" && /^[A-Z]{2}$/u.test(value) ? value : undefined;
  if (key === "statusCode") return typeof value === "number" && Number.isInteger(value)
    && value >= 100 && value <= 599 ? value : undefined;
  if (key === "retryable") return typeof value === "boolean" ? value : undefined;
  if (["event", "operation", "outcome", "provider", "queue", "reason", "region", "service", "status"]
    .includes(key)) {
    return typeof value === "string" && STABLE_VALUE.test(value) ? value : undefined;
  }
  return undefined;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
}

export function redactErrorContext(context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    const sanitized = safeContextValue(key, value);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

export function toErrorResponse(
  error: unknown,
  traceId: string,
  options: ErrorResponseOptions = {},
): ErrorResponse {
  const applicationError = error instanceof AppError ? error : undefined;
  const code = applicationError?.code ?? "INTERNAL_ERROR";
  const logger = options.logger ?? console;
  const logContext: Record<string, unknown> = {
    code,
    errorName: safeErrorName(error),
    traceId,
  };
  if (applicationError?.context) logContext.context = redactErrorContext(applicationError.context);
  logger.error("application_error", logContext);

  if (!applicationError) {
    return {
      status: 500,
      body: {
        code,
        messageKey: "errors.internal",
        retryable: true,
        traceId,
      },
    };
  }

  return {
    status: applicationError.status,
    body: {
      code,
      messageKey: applicationError.messageKey,
      ...(applicationError.fieldErrors ? { fieldErrors: applicationError.fieldErrors } : {}),
      retryable: applicationError.retryable,
      traceId,
    },
  };
}
