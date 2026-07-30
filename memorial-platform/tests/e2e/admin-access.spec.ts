import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";

/**
 * Role separation on the moderation surface, exercised through the browser.
 *
 * The fixtures are created directly in the database the dev server is using,
 * and a session cookie is minted the same way the application does. Going
 * through the sign-in flow would mean reading a one-time code out of the
 * server's stdout, which is fragile; what this test is actually about is what
 * each role sees once signed in.
 */

const SESSION_COOKIE_NAME = "memorial_session";

/** Reads a value from the same .env.local the dev server is using. */
function fromEnvFile(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  const raw = readFileSync(".env.local", "utf8");
  const match = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`${key} is required to set up admin fixtures`);
  }
  return match[1].trim();
}

const databaseUrl = (): string => fromEnvFile("DATABASE_URL");
const sessionSecret = (): string => fromEnvFile("SESSION_SECRET");

/** Mirrors modules/auth/sessions.ts. */
function hashSessionToken(token: string, secret: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", secret, "memorial-platform/v1", "session-token", 32),
  );
  return createHmac("sha256", key).update(token, "utf8").digest("hex");
}

type Fixture = { userId: string; token: string };

const created: string[] = [];

async function makeSignedInUser(
  role: "user" | "reviewer" | "super_admin",
): Promise<Fixture> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    const { rows } = await client.query(
      `insert into users (display_name, platform_role) values ($1, $2) returning id`,
      [`E2E ${role} ${randomUUID().slice(0, 8)}`, role],
    );
    const userId = rows[0].id as string;
    created.push(userId);

    const token = randomBytes(32).toString("hex");
    await client.query(
      `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')`,
      [userId, hashSessionToken(token, sessionSecret())],
    );

    return { userId, token };
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  if (created.length === 0) return;
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  await client.query(`delete from users where id = any($1)`, [created]);
  await client.end();
});

test.describe("who can reach the moderation surface", () => {
  test("an anonymous visitor gets 404", async ({ page }) => {
    // 404 rather than 403: a 403 confirms the surface exists and is worth
    // probing.
    const response = await page.goto("/en/admin");
    expect(response?.status()).toBe(404);
  });

  test("an ordinary signed-in user gets 404", async ({ page, context }) => {
    const fixture = await makeSignedInUser("user");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const response = await page.goto("/en/admin");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("admin-surface")).toHaveCount(0);
  });

  test("a reviewer sees the queues", async ({ page, context }) => {
    const fixture = await makeSignedInUser("reviewer");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const response = await page.goto("/en/admin");
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId("queue-reports")).toBeVisible();
    await expect(page.getByTestId("queue-disputes")).toBeVisible();
    await expect(page.getByTestId("queue-rituals")).toBeVisible();
  });

  test("a reviewer does not see the publishing surface", async ({
    page,
    context,
  }) => {
    // Publishing a ritual revision is a super-admin action: it becomes a
    // statement about someone's faith.
    const fixture = await makeSignedInUser("reviewer");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    await page.goto("/en/admin");
    await expect(page.getByTestId("super-admin-only")).toHaveCount(0);
  });

  test("a super admin does see it", async ({ page, context }) => {
    const fixture = await makeSignedInUser("super_admin");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    await page.goto("/en/admin");
    await expect(page.getByTestId("super-admin-only")).toBeVisible();
  });
});

test.describe("what the queues disclose", () => {
  test("show no evidence object key", async ({ page, context }) => {
    // Doc 06 sections 5 and 7: evidence is opened deliberately, and opening it
    // is audited. A key in a list view would route around both.
    const fixture = await makeSignedInUser("reviewer");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    await page.goto("/en/admin");
    const html = await page.content();

    expect(html).not.toContain("dispute-evidence/");
  });

  test("show no reporter contact details", async ({ page, context }) => {
    const fixture = await makeSignedInUser("reviewer");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    await page.goto("/en/admin");

    // Scoped to the rendered surface rather than the whole document. The
    // framework payload carries the serialized message catalogue, which
    // legitimately contains a placeholder address on the sign-in form; matching
    // that would be a false alarm rather than a finding.
    const rendered = await page.getByTestId("admin-surface").innerText();

    // A queue is a list to work through, not thirty people's addresses on
    // screen at once.
    expect(rendered).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

test.describe("a revoked session", () => {
  test("loses access immediately", async ({ page, context }) => {
    const fixture = await makeSignedInUser("reviewer");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: fixture.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    expect((await page.goto("/en/admin"))?.status()).toBe(200);

    const client = new pg.Client({ connectionString: databaseUrl() });
    await client.connect();
    await client.query(`update sessions set revoked_at = now() where user_id = $1`, [
      fixture.userId,
    ]);
    await client.end();

    // No cache stands between revoking a staff session and losing the surface.
    expect((await page.goto("/en/admin"))?.status()).toBe(404);
  });
});
