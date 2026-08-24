import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SPAN_NAMES,
  configureObservability,
  recordMetric,
  withSpan,
} from "@/infrastructure/observability/tracing";

describe("observability tracing", () => {
  afterEach(() => configureObservability());

  it("provides stable span names for every required subsystem", () => {
    expect(SPAN_NAMES).toEqual({
      http: "http.request",
      database: "database.query",
      queue: "queue.process",
      realtime: "realtime.event",
      payment: "payment.operation",
      media: "media.operation",
      moderation: "moderation.operation",
    });
  });

  it("records and closes a span without sensitive attributes", async () => {
    const end = vi.fn();
    const recordException = vi.fn();
    const startSpan = vi.fn(() => ({ end, recordException }));
    configureObservability({ startSpan, recordMetric: vi.fn() });

    const error = new Error("private detail");
    error.name = "Bearer secret-token private@example.test";

    await expect(withSpan("payment", "checkout", {
      route: "/api/v1/checkout-sessions",
      provider: "stripe",
      email: "private@example.test",
      phone: "+15555550123",
      messageText: "secret message",
      latitude: 37.7749,
      longitude: -122.4194,
      payload: "Contact private@example.test; Bearer abc.secret; private message",
      contact: "+15555550123",
      coordinates: "37.7749,-122.4194",
    }, async () => { throw error; })).rejects.toBe(error);

    expect(startSpan).toHaveBeenCalledWith("payment.operation", {
      operation: "checkout",
      route: "/api/v1/checkout-sessions",
      provider: "stripe",
    });
    expect(recordException).toHaveBeenCalledWith({ errorName: "Error" });
    expect(end).toHaveBeenCalledOnce();
  });

  it("drops private dimensions from metrics", () => {
    const metric = vi.fn();
    configureObservability({ startSpan: vi.fn(() => ({ end: vi.fn() })), recordMetric: metric });

    recordMetric("http.requests", 1, {
      method: "POST",
      countryCode: "US",
      email: "private@example.test",
      phone: "+15555550123",
      messageText: "hello",
      exactLocation: "37.7749,-122.4194",
      arbitraryDimension: "could be message text",
      payload: "private@example.test Bearer abc.secret message body",
      contact: "+1 (555) 555-0123",
      coordinates: [37.7749, -122.4194],
      provider: "private@example.test Bearer abc.secret",
    });

    expect(metric).toHaveBeenCalledWith("http.requests", 1, { method: "POST", countryCode: "US" });
  });

  it("runs the application task when starting a span fails", async () => {
    const task = vi.fn(async () => "result");
    configureObservability({
      startSpan: () => { throw new Error("sink start failed"); },
      recordMetric: vi.fn(),
    });

    await expect(withSpan("database", "profile.read", {}, task)).resolves.toBe("result");
    expect(task).toHaveBeenCalledOnce();
  });

  it("preserves the original task error when exception recording and span closing fail", async () => {
    const applicationError = new TypeError("application failure");
    configureObservability({
      startSpan: () => ({
        recordException: () => { throw new Error("sink exception failed"); },
        end: () => { throw new Error("sink end failed"); },
      }),
      recordMetric: vi.fn(),
    });

    await expect(withSpan("queue", "notification.send", {}, async () => { throw applicationError; }))
      .rejects.toBe(applicationError);
  });

  it("returns a successful task result when closing a span fails", async () => {
    configureObservability({
      startSpan: () => ({ end: () => { throw new Error("sink end failed"); } }),
      recordMetric: vi.fn(),
    });

    await expect(withSpan("media", "photo.review", {}, async () => 42)).resolves.toBe(42);
  });

  it("does not throw when the metric sink fails", () => {
    configureObservability({
      startSpan: vi.fn(() => ({ end: vi.fn() })),
      recordMetric: () => { throw new Error("sink metric failed"); },
    });

    expect(() => recordMetric("http.requests", 1, { method: "GET" })).not.toThrow();
  });
});
