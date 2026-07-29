/**
 * Stable, public API error codes.
 *
 * Clients branch on the code; humans read the localized copy the client renders
 * for that code. The English strings below are a safe last resort, not the
 * translation surface.
 *
 * See docs/memorial-platform/04-api-contracts.md sections 1, 2 and 10.
 */
export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "FEATURE_DISABLED",
  "INVALID_INPUT",
  "MEMORIAL_NOT_FOUND",
  "MEMORIAL_FORBIDDEN",
  "INVITATION_REQUIRED",
  "RELATIONSHIP_NOT_ELIGIBLE",
  "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED",
  "DUPLICATE_CANDIDATE_FOUND",
  "RITUAL_NOT_ENABLED",
  "RITUAL_COMBINATION_PROHIBITED",
  "CONTENT_PENDING_REVIEW",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "EXPORT_IN_PROGRESS",
  "CALENDAR_NOT_CONFIGURED",
  "DEPENDENCY_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * `MEMORIAL_NOT_FOUND` is deliberately the answer for an unauthorized request to
 * an unlisted or invite-only memorial: 403 would confirm that it exists.
 * `INVITATION_REQUIRED` is only for a viewer who already knows about it, such as
 * someone following an invitation link that has expired.
 */
const HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  FEATURE_DISABLED: 403,
  INVALID_INPUT: 400,
  MEMORIAL_NOT_FOUND: 404,
  MEMORIAL_FORBIDDEN: 403,
  INVITATION_REQUIRED: 403,
  RELATIONSHIP_NOT_ELIGIBLE: 422,
  PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED: 422,
  DUPLICATE_CANDIDATE_FOUND: 409,
  RITUAL_NOT_ENABLED: 403,
  RITUAL_COMBINATION_PROHIBITED: 422,
  CONTENT_PENDING_REVIEW: 202,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  EXPORT_IN_PROGRESS: 409,
  CALENDAR_NOT_CONFIGURED: 422,
  DEPENDENCY_UNAVAILABLE: 503,
};

const PUBLIC_MESSAGE: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "Please sign in to continue.",
  SESSION_EXPIRED: "Your session has ended. Please sign in again.",
  FEATURE_DISABLED: "This feature is not available.",
  INVALID_INPUT: "Some of the information provided could not be accepted.",
  MEMORIAL_NOT_FOUND: "This memorial is not available.",
  MEMORIAL_FORBIDDEN: "You do not have permission to perform this action.",
  INVITATION_REQUIRED: "An invitation from the family is required to view this memorial.",
  RELATIONSHIP_NOT_ELIGIBLE:
    "Only a spouse, parent, child or sibling can create a memorial.",
  PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED:
    "Please confirm that this memorial may be seen publicly before continuing.",
  DUPLICATE_CANDIDATE_FOUND:
    "A similar memorial already exists. Please review it before creating a new one.",
  RITUAL_NOT_ENABLED: "The family has not enabled this way of remembering.",
  RITUAL_COMBINATION_PROHIBITED:
    "These ways of remembering cannot be offered together on one memorial.",
  CONTENT_PENDING_REVIEW: "Thank you. The family will review this before it appears.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  IDEMPOTENCY_CONFLICT:
    "This request was already submitted with different details.",
  EXPORT_IN_PROGRESS: "An export is already being prepared for this memorial.",
  CALENDAR_NOT_CONFIGURED:
    "This calendar is not supported yet, so no date can be offered.",
  DEPENDENCY_UNAVAILABLE: "This service is temporarily unavailable. Please try again.",
};

export type FieldErrors = Record<string, string[]>;

export type ErrorResponseBody = {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors: FieldErrors;
  };
  meta: { correlationId: string };
};

export type SuccessResponseBody<T> = {
  data: T;
  meta: { correlationId: string };
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

/**
 * Builds the public failure envelope.
 *
 * There is deliberately no `message` parameter: prose is looked up from the
 * code, so a stack trace, SQL fragment, object storage key, provider response or
 * internal risk score has no route into a response body. Field errors are the
 * only caller-supplied text and belong to validated form fields.
 */
export function errorResponseBody(input: {
  code: ErrorCode;
  correlationId: string;
  fieldErrors?: FieldErrors;
}): ErrorResponseBody {
  return {
    error: {
      code: input.code,
      message: PUBLIC_MESSAGE[input.code],
      fieldErrors: input.fieldErrors ?? {},
    },
    meta: { correlationId: input.correlationId },
  };
}

export function successResponseBody<T>(
  data: T,
  correlationId: string,
): SuccessResponseBody<T> {
  return { data, meta: { correlationId } };
}
