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
    const startSpan = vi.fn(() => ({ end, recordException: vi.fn() }));
    configureObservability({ startSpan, recordMetric: vi.fn() });

    await expect(withSpan("payment", "checkout", {
      route: "/api/v1/checkout-sessions",
      email: "private@example.test",
      phone: "+15555550123",
      messageText: "secret message",
      latitude: 37.7749,
      longitude: -122.4194,
    }, async () => "ok")).resolves.toBe("ok");

    expect(startSpan).toHaveBeenCalledWith("payment.operation", {
      operation: "checkout",
      route: "/api/v1/checkout-sessions",
    });
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
    });

    expect(metric).toHaveBeenCalledWith("http.requests", 1, { method: "POST", countryCode: "US" });
  });
});
