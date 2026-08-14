import { timingSafeEqual } from "node:crypto";

const bearerMatches = (authorization: string | null, secret: string) => {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(authorization ?? "", "utf8");
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
};

export function createBillingWorkerRoute(input: {
  secret: string;
  run(): Promise<{ entitlement: { processed: number; failed: number }; reconciliation: { runs: number } }>;
}) {
  return async (request: Request) => {
    if (!bearerMatches(request.headers.get("authorization"), input.secret)) {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }
    try { return Response.json(await input.run()); } catch {
      return Response.json({ code: "BILLING_WORKER_FAILED" }, { status: 500 });
    }
  };
}
