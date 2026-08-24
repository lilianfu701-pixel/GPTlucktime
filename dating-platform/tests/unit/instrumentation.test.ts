import { afterEach, describe, expect, it, vi } from "vitest";

import { configureObservability } from "@/infrastructure/observability/tracing";
import { onRequestError, register } from "@/instrumentation";

describe("Next instrumentation", () => {
  afterEach(() => configureObservability());

  it("registers without external network activity", () => {
    expect(register()).toBeUndefined();
  });

  it("captures request errors using route templates and no request PII", async () => {
    const end = vi.fn();
    const recordException = vi.fn();
    const startSpan = vi.fn(() => ({ end, recordException }));
    configureObservability({ startSpan, recordMetric: vi.fn() });

    await onRequestError(
      new Error("private database detail"),
      {
        path: "/users/private@example.test?phone=%2B15555550123",
        method: "POST",
        headers: { authorization: "Bearer private" },
      },
      {
        routerKind: "App Router",
        routePath: "/api/v1/profiles/[profileId]",
        routeType: "route",
        renderSource: "server-rendering",
        revalidateReason: undefined,
      },
    );

    expect(startSpan).toHaveBeenCalledWith("http.request", {
      operation: "request.error",
      method: "POST",
      route: "/api/v1/profiles/[profileId]",
      routeType: "route",
      routerKind: "App Router",
    });
    expect(JSON.stringify(startSpan.mock.calls)).not.toContain("private@example.test");
    expect(recordException).toHaveBeenCalledWith({ errorName: "Error" });
    expect(end).toHaveBeenCalledOnce();
  });
});
