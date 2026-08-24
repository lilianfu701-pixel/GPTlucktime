import type { Instrumentation } from "next";

import { captureException, recordMetric } from "@/infrastructure/observability/tracing";

export function register(): void {
  recordMetric("application.start", 1, {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
  });
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  captureException("http", "request.error", error, {
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
  });
};
