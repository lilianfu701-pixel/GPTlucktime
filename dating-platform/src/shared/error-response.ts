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

const SENSITIVE_KEY = /(?:address|authorization|cookie|email|latitude|lat|longitude|lng|location|message|password|phone|secret|text|token)/iu;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_VALUE = /^\+?\d[\d\s().-]{7,}$/u;

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  if (typeof value === "string" && (EMAIL_VALUE.test(value) || PHONE_VALUE.test(value))) return "[REDACTED]";
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry, seen),
  ]));
}

export function redactErrorContext(context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(context, new WeakSet()) as Readonly<Record<string, unknown>>;
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
    errorName: error instanceof Error ? error.name : "UnknownError",
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
