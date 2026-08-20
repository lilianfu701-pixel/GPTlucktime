import { timingSafeEqual } from "node:crypto";

const bearerMatches = (authorization: string | null, secret: string) => {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authorization ?? "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export function createAdminApprovalWorkerRoute(input: {
  secret: string;
  run(): Promise<unknown>;
}) {
  return async (request: Request) => {
    if (request.method !== "POST") return Response.json({ code: "METHOD_NOT_ALLOWED" }, {
      status: 405, headers: { "cache-control": "private, no-store" },
    });
    if (!bearerMatches(request.headers.get("authorization"), input.secret)) {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "private, no-store" } });
    }
    try {
      return Response.json(await input.run(), { headers: { "cache-control": "private, no-store" } });
    } catch {
      return Response.json({ code: "ADMIN_WORKER_FAILED" }, { status: 500,
        headers: { "cache-control": "private, no-store" } });
    }
  };
}
