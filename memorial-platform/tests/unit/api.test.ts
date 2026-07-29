import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CORRELATION_HEADER,
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("correlationIdFrom", () => {
  it("keeps a well-formed caller-supplied id", () => {
    const request = post({}, { [CORRELATION_HEADER]: "req_client-123" });
    expect(correlationIdFrom(request)).toBe("req_client-123");
  });

  it("generates one when the header is absent", () => {
    expect(correlationIdFrom(post({}))).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it("replaces a header that is not an identifier", () => {
    // The value ends up in every log line for the request, so it must not carry
    // spaces, markup or unbounded length.
    //
    // A literal newline is not covered here because the `Request` constructor
    // rejects it before any application code runs; the platform already
    // guarantees that one.
    for (const bad of [
      "has spaces",
      "<script>alert(1)</script>",
      "a".repeat(65),
      "",
      "tab\there",
    ]) {
      expect(correlationIdFrom(post({}, { [CORRELATION_HEADER]: bad }))).toMatch(
        /^req_[0-9a-f-]{36}$/,
      );
    }
  });
});

describe("status separation for rejected input", () => {
  it("answers 400 when the body cannot be read", async () => {
    // Doc 04 section 2: 400 means the request could not be parsed.
    const schema = z.object({ email: z.string() });
    const result = await readJson(post("{not json"), schema, "req_1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
  });

  it("answers 400 when the body does not match the schema", async () => {
    const schema = z.object({ email: z.string() });
    const result = await readJson(post({ email: 42 }), schema, "req_1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
  });

  it("answers 422 when a business rule rejects readable input", () => {
    // Doc 04 section 2: 422 means the request was understood and refused.
    const response = jsonUnprocessable("req_1", {
      email: ["Enter a valid email address."],
    });
    expect(response.status).toBe(422);
  });

  it("reports every offending field", async () => {
    const schema = z.object({
      email: z.string().min(1, { error: "An email address is required." }),
      code: z.string().regex(/^\d{6}$/, { error: "Six digits." }),
    });
    const result = await readJson(post({ email: "", code: "abc" }), schema, "req_1");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const body = (await result.response.json()) as {
      error: { fieldErrors: Record<string, string[]> };
    };
    expect(Object.keys(body.error.fieldErrors).sort()).toEqual(["code", "email"]);
    expect(body.error.fieldErrors["email"]).toEqual([
      "An email address is required.",
    ]);
  });

  it("does not forward the value that was rejected", async () => {
    // A schema failure must not echo what was submitted: for auth routes that
    // value is a credential.
    const schema = z.object({
      code: z.string().regex(/^\d{6}$/, { error: "Six digits." }),
    });
    const result = await readJson(post({ code: "hunter2-secret" }), schema, "req_1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(await result.response.json())).not.toContain(
      "hunter2-secret",
    );
  });
});

describe("response envelopes", () => {
  it("never lets an authenticated answer enter a shared cache", async () => {
    const success = jsonSuccess({ userId: "abc" }, "req_1");
    const failure = jsonError("MEMORIAL_FORBIDDEN", "req_1");

    expect(success.headers.get("cache-control")).toBe("private, no-store");
    expect(failure.headers.get("cache-control")).toBe("private, no-store");
  });

  it("echoes the correlation id in a header as well as the body", async () => {
    const response = jsonSuccess({}, "req_abc");
    expect(response.headers.get(CORRELATION_HEADER)).toBe("req_abc");
    expect(await response.json()).toEqual({
      data: {},
      meta: { correlationId: "req_abc" },
    });
  });

  it("uses the documented status for each error code", () => {
    expect(jsonError("AUTH_REQUIRED", "req_1").status).toBe(401);
    expect(jsonError("FEATURE_DISABLED", "req_1").status).toBe(403);
    expect(jsonError("MEMORIAL_NOT_FOUND", "req_1").status).toBe(404);
    expect(jsonError("RATE_LIMITED", "req_1").status).toBe(429);
    expect(jsonError("DEPENDENCY_UNAVAILABLE", "req_1").status).toBe(503);
  });
});
