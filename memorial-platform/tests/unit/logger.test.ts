import { describe, expect, it } from "vitest";
import { createLogger, redact } from "@/lib/logger";

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("what a log line looks like", () => {
  it("is one JSON object per line", () => {
    const sink = capture();
    const log = createLogger({ write: sink.write, service: "web" });

    log.info("memorial.created", { memorialId: "abc" });

    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.event).toBe("memorial.created");
    expect(parsed.level).toBe("info");
    expect(parsed.service).toBe("web");
    expect(parsed.memorialId).toBe("abc");
    expect(typeof parsed.time).toBe("string");
  });

  it("carries the correlation id through every line of a request", () => {
    // Without this an operator cannot reconstruct what happened to one person.
    const sink = capture();
    const log = createLogger({ write: sink.write, service: "web" }).child({
      correlationId: "req_123",
    });

    log.info("first");
    log.warn("second");

    for (const line of sink.lines) {
      expect(JSON.parse(line).correlationId).toBe("req_123");
    }
  });

  it("keeps a child's context without touching its parent", () => {
    const sink = capture();
    const parent = createLogger({ write: sink.write, service: "worker" });
    parent.child({ correlationId: "req_a" }).info("child line");
    parent.info("parent line");

    const [child, plain] = sink.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(child!.correlationId).toBe("req_a");
    expect(plain!.correlationId).toBeUndefined();
  });
});

describe("what must never reach a log", () => {
  const secrets = {
    password: "hunter2",
    token: "tok_live_abc",
    sessionToken: "sess_abc",
    authorization: "Bearer abc",
    apiKey: "sk-abc",
    otp: "123456",
    code: "123456",
    secret: "s3cr3t",
    email: "someone@example.com",
    phone: "+14155550123",
  };

  for (const [key, value] of Object.entries(secrets)) {
    it(`redacts ${key}`, () => {
      const redacted = redact({ [key]: value }) as Record<string, unknown>;
      expect(redacted[key]).toBe("[redacted]");
      expect(JSON.stringify(redacted)).not.toContain(value);
    });
  }

  it("redacts however the key is spelled", () => {
    // Nobody remembers to write the key the same way twice.
    const redacted = redact({
      API_KEY: "sk-1",
      "x-session-token": "sess-1",
      userPassword: "pw-1",
    });

    expect(JSON.stringify(redacted)).not.toContain("sk-1");
    expect(JSON.stringify(redacted)).not.toContain("sess-1");
    expect(JSON.stringify(redacted)).not.toContain("pw-1");
  });

  it("reaches into nested objects and arrays", () => {
    const redacted = redact({
      request: { headers: { authorization: "Bearer leak" } },
      users: [{ email: "a@example.com" }],
    });

    expect(JSON.stringify(redacted)).not.toContain("Bearer leak");
    expect(JSON.stringify(redacted)).not.toContain("a@example.com");
  });

  it("redacts on the way out of the logger, not only when asked", () => {
    const sink = capture();
    createLogger({ write: sink.write, service: "web" }).info("auth.attempt", {
      email: "someone@example.com",
    });

    expect(sink.lines[0]).not.toContain("someone@example.com");
  });

  it("leaves an identifier that is safe to keep", () => {
    // Redacting everything would be as useless as redacting nothing: a user id
    // is what lets an operator answer a support request at all.
    const redacted = redact({ userId: "u_1", memorialId: "m_1" }) as Record<
      string,
      unknown
    >;

    expect(redacted.userId).toBe("u_1");
    expect(redacted.memorialId).toBe("m_1");
  });

  it("does not choke on a value that cannot be serialized", () => {
    // A log line that throws takes the request down with it.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const sink = capture();

    expect(() =>
      createLogger({ write: sink.write, service: "web" }).error("boom", {
        cyclic,
      }),
    ).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });

  it("keeps an Error readable without dumping the whole stack", () => {
    const sink = capture();
    createLogger({ write: sink.write, service: "web" }).error("failed", {
      error: new Error("upstream refused"),
    });

    const parsed = JSON.parse(sink.lines[0]!) as {
      error: { name: string; message: string };
    };
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("upstream refused");
  });
});
