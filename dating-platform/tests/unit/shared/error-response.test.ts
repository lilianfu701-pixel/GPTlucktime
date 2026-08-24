import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/app-error";
import { toErrorResponse } from "@/shared/error-response";

describe("toErrorResponse", () => {
  it("rejects raw field-error details that are not localization keys", () => {
    expect(() => new AppError({
      code: "PROFILE_INVALID",
      status: 422,
      messageKey: "errors.profile.invalid",
      fieldErrors: { displayName: "database value private@example.test" },
    })).toThrow("APP_ERROR_FIELD_MESSAGE_KEY_INVALID");
  });

  it("copies and freezes validated field errors", () => {
    const fieldErrors: Record<string, string> = {
      displayName: "errors.profile.displayName.required",
    };
    const error = new AppError({
      code: "PROFILE_INVALID",
      status: 422,
      messageKey: "errors.profile.invalid",
      fieldErrors,
    });

    fieldErrors.displayName = "raw private detail";
    fieldErrors.email = "private@example.test";
    expect(error.fieldErrors).toEqual({ displayName: "errors.profile.displayName.required" });
    expect(error.fieldErrors).not.toBe(fieldErrors);
    expect(Object.isFrozen(error.fieldErrors)).toBe(true);
    expect(() => Object.assign(error.fieldErrors!, { displayName: "raw mutation" })).toThrow(TypeError);
  });

  it("returns a generic retryable response for unknown errors without leaking details", () => {
    const logger = { error: vi.fn() };

    const response = toErrorResponse(new Error("password table unavailable"), "trace-1", { logger });

    expect(response).toEqual({
      status: 500,
      body: {
        code: "INTERNAL_ERROR",
        messageKey: "errors.internal",
        retryable: true,
        traceId: "trace-1",
      },
    });
    expect(JSON.stringify(response)).not.toContain("password table unavailable");
    expect(logger.error).toHaveBeenCalledWith("application_error", {
      code: "INTERNAL_ERROR",
      errorName: "Error",
      traceId: "trace-1",
    });
  });

  it("maps stable application errors and redacts sensitive logging context", () => {
    const logger = { error: vi.fn() };
    const error = new AppError({
      code: "PROFILE_INVALID",
      status: 422,
      messageKey: "errors.profile.invalid",
      fieldErrors: { displayName: "errors.profile.displayName.required" },
      retryable: false,
      context: {
        operation: "profile.update",
        provider: "identity_vendor",
        route: "/api/v1/profiles/[profileId]",
        email: "private@example.test",
        actor: "private@example.test",
        nested: { phone: "+15555550123", countryCode: "US" },
        payload: "Contact private@example.test or +1 (555) 555-0123; Bearer abc.secret; message hello",
        coordinates: [37.7749, -122.4194],
        contact: "Authorization: Bearer opaque-private-value",
        "private@example.test": "field names are attacker controlled too",
      },
    });

    expect(toErrorResponse(error, "trace-2", { logger })).toEqual({
      status: 422,
      body: {
        code: "PROFILE_INVALID",
        messageKey: "errors.profile.invalid",
        fieldErrors: { displayName: "errors.profile.displayName.required" },
        retryable: false,
        traceId: "trace-2",
      },
    });
    expect(logger.error).toHaveBeenCalledWith("application_error", {
      code: "PROFILE_INVALID",
      errorName: "AppError",
      traceId: "trace-2",
      context: {
        operation: "profile.update",
        provider: "identity_vendor",
        route: "/api/v1/profiles/[profileId]",
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
      /private@example\.test|555|Bearer|abc\.secret|37\.7749|122\.4194|message hello/u,
    );
  });

  it("does not log attacker-controlled error names", () => {
    const logger = { error: vi.fn() };
    const error = new Error("internal");
    error.name = "Bearer private-token private@example.test";

    toErrorResponse(error, "trace-3", { logger });

    expect(logger.error).toHaveBeenCalledWith("application_error", {
      code: "INTERNAL_ERROR",
      errorName: "Error",
      traceId: "trace-3",
    });
  });
});
