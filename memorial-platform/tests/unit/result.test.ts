import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok, unwrapOr } from "@/lib/result";
import type { Result } from "@/lib/result";

type SampleError = "NOT_FOUND" | "FORBIDDEN";

describe("Result", () => {
  it("carries a value on success", () => {
    const result = ok({ memorialId: "abc" });
    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.memorialId).toBe("abc");
    }
  });

  it("carries a stable code on failure", () => {
    const result = err<SampleError>("FORBIDDEN");
    expect(result.ok).toBe(false);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error).toBe("FORBIDDEN");
    }
  });

  it("narrows the union so callers must handle both branches", () => {
    const decide = (allowed: boolean): Result<string, SampleError> =>
      allowed ? ok("visible") : err("NOT_FOUND");

    const allowed = decide(true);
    const denied = decide(false);

    expect(isOk(allowed) && allowed.value).toBe("visible");
    expect(isErr(denied) && denied.error).toBe("NOT_FOUND");
  });

  it("falls back to the supplied default on failure", () => {
    expect(unwrapOr(ok(7), 0)).toBe(7);
    expect(unwrapOr(err<SampleError>("NOT_FOUND"), 0)).toBe(0);
  });

  it("treats a falsy success value as success rather than absence", () => {
    expect(unwrapOr(ok(0), 99)).toBe(0);
    expect(unwrapOr(ok(false), true)).toBe(false);
    expect(unwrapOr(ok(null), "fallback")).toBeNull();
  });
});
