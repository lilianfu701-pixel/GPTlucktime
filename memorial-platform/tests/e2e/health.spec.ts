import { expect, test } from "@playwright/test";

/**
 * The probes, as a load balancer sees them.
 *
 * Status code, not body content: a probe that has to parse JSON to learn the
 * answer is a probe somebody will configure wrong.
 */

test("liveness answers without touching anything else", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("readiness reports a migrated database as ready", async ({ request }) => {
  const response = await request.get("/api/health/ready");
  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    status: string;
    migrations: { expected: number; applied: number };
  };
  expect(body.status).toBe("ready");
  expect(body.migrations.applied).toBeGreaterThanOrEqual(
    body.migrations.expected,
  );
});

test("neither probe is cached", async ({ request }) => {
  // A cached readiness answer keeps sending traffic to an instance that has
  // already stopped being ready.
  for (const path of ["/api/health", "/api/health/ready"]) {
    const response = await request.get(path);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});

test("readiness discloses nothing about the connection", async ({ request }) => {
  const body = await (await request.get("/api/health/ready")).text();
  expect(body).not.toContain("postgres");
  expect(body).not.toContain("@");
});
