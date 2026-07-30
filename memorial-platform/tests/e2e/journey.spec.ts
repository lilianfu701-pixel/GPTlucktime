import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";

/**
 * One family, start to finish, over real HTTP.
 *
 * Every step below is a request the application actually serves. The point is
 * not any single endpoint — each has its own tests — but the sequence: that a
 * memorial created in step three is the one made private in step five, is the
 * one a stranger cannot reach in step six, and is gone in step nine.
 *
 * The sign-in code is the one thing not driven end to end here. It is delivered
 * by an email provider inside the server process, so a browser test has no way
 * to read it without a back door, and a back door that returns login codes is
 * not worth having for a test. Requesting the code goes through the real route;
 * completing it is covered by tests/integration/auth-flow.test.ts, which uses
 * the in-memory provider and checks the code itself.
 */

const SESSION_COOKIE_NAME = "memorial_session";

function fromEnvFile(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  const raw = readFileSync(".env.local", "utf8");
  const match = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`${key} is required for the journey fixtures`);
  }
  return match[1].trim();
}

/** Mirrors modules/auth/sessions.ts. */
function hashSessionToken(token: string, secret: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", secret, "memorial-platform/v1", "session-token", 32),
  );
  return createHmac("sha256", key).update(token, "utf8").digest("hex");
}

let client: pg.Client;
const createdUserIds: string[] = [];

test.beforeAll(async () => {
  client = new pg.Client({ connectionString: fromEnvFile("DATABASE_URL") });
  await client.connect();
});

test.afterAll(async () => {
  if (createdUserIds.length > 0) {
    const owned = await client.query<{ id: string; deceased_person_id: string }>(
      "select id, deceased_person_id from memorials where owner_user_id = any($1)",
      [createdUserIds],
    );
    const ids = owned.rows.map((row) => row.id);
    if (ids.length > 0) {
      await client.query("delete from export_jobs where memorial_id = any($1)", [ids]);
      await client.query("delete from commemorations where memorial_id = any($1)", [ids]);
      await client.query("delete from search_documents where memorial_id = any($1)", [ids]);
      await client.query("delete from audit_logs where resource_id = any($1)", [ids]);
      await client.query("delete from outbox_events where aggregate_id = any($1)", [ids]);
      await client.query("delete from memorials where id = any($1)", [ids]);
      await client.query("delete from deceased_people where id = any($1)", [
        owned.rows.map((row) => row.deceased_person_id),
      ]);
    }
    await client.query("delete from users where id = any($1)", [createdUserIds]);
  }
  await client.end();
});

async function signedInUser(label: string): Promise<{ userId: string; token: string }> {
  const { rows } = await client.query<{ id: string }>(
    "insert into users (display_name) values ($1) returning id",
    [`${label} ${randomUUID().slice(0, 8)}`],
  );
  const userId = rows[0]!.id;
  createdUserIds.push(userId);

  const token = randomBytes(32).toString("hex");
  await client.query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')",
    [userId, hashSessionToken(token, fromEnvFile("SESSION_SECRET"))],
  );

  return { userId, token };
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

test("a family creates, protects, exports and deletes a memorial", async ({
  request,
}) => {
  const surname = `Journey${randomUUID().slice(0, 6)}`;

  // 1. Someone asks for a sign-in code. The answer is the same whether or not
  //    the address is known, so this cannot be used to test who has an account.
  const known = await request.post("/api/auth/email/request", {
    data: { email: "someone@example.com", locale: "en" },
  });
  const unknown = await request.post("/api/auth/email/request", {
    data: { email: `nobody-${randomUUID()}@example.com`, locale: "en" },
  });
  expect(known.status()).toBe(202);
  expect(unknown.status()).toBe(202);

  const owner = await signedInUser("Owner");

  // 2. Creating a memorial requires accepting the relationship statement.
  const withoutStatement = await request.post("/api/memorials", {
    headers: { ...cookieHeader(owner.token), "idempotency-key": randomUUID() },
    data: {
      relationship: "child",
      relationshipStatementAccepted: false,
      primaryName: { value: surname },
    },
  });
  expect(withoutStatement.status()).toBe(422);
  expect(await withoutStatement.text()).toContain("relationshipStatementAccepted");

  // 3. The real thing.
  const idempotencyKey = randomUUID();
  const created = await request.post("/api/memorials", {
    headers: { ...cookieHeader(owner.token), "idempotency-key": idempotencyKey },
    data: {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: surname },
      deathDate: { value: "2024-03-04", precision: "day" },
      visibility: "public",
    },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as {
    data: { memorialId: string; slug: string };
  };
  const memorialId = body.data.memorialId;
  expect(body.data.slug).toContain(surname.toLowerCase());

  // 4. A retry of the same request must not produce a second memorial. A
  //    duplicate here is a second page for one death, found by the family later.
  const retried = await request.post("/api/memorials", {
    headers: { ...cookieHeader(owner.token), "idempotency-key": idempotencyKey },
    data: {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: surname },
      deathDate: { value: "2024-03-04", precision: "day" },
      visibility: "public",
    },
  });
  expect([200, 201]).toContain(retried.status());
  expect(((await retried.json()) as { data: { memorialId: string } }).data.memorialId).toBe(
    memorialId,
  );

  // 5. The family decides it should be invite-only.
  const privacy = await request.patch(`/api/memorials/${memorialId}/privacy`, {
    headers: cookieHeader(owner.token),
    data: { visibility: "invite_only" },
  });
  expect(privacy.status()).toBe(200);

  const row = await client.query<{ visibility: string }>(
    "select visibility from memorials where id = $1",
    [memorialId],
  );
  // Recorded on the row itself, not queued: a privacy decision that waits on a
  // worker is a privacy decision that has not been made.
  expect(row.rows[0]!.visibility).toBe("invite_only");

  // 6. A stranger asking for it gets the same answer as for a memorial that was
  //    never created. A 403 would confirm it exists.
  const stranger = await signedInUser("Stranger");
  const strangerPrivacy = await request.patch(
    `/api/memorials/${memorialId}/privacy`,
    { headers: cookieHeader(stranger.token), data: { visibility: "public" } },
  );
  const madeUp = await request.patch(
    `/api/memorials/${randomUUID()}/privacy`,
    { headers: cookieHeader(stranger.token), data: { visibility: "public" } },
  );
  expect(strangerPrivacy.status()).toBe(404);
  expect(madeUp.status()).toBe(strangerPrivacy.status());

  // 7. It never reaches public search either.
  const search = await request.get(`/api/search?q=${surname}`);
  expect(search.status()).toBe(200);
  const hits = (await search.json()) as { data: { results: { slug: string }[] } };
  expect(hits.data.results.map((hit) => hit.slug)).not.toContain(body.data.slug);

  // 8. The family asks for a copy of everything they wrote.
  const exported = await request.post(`/api/memorials/${memorialId}/export`, {
    headers: { ...cookieHeader(owner.token), "idempotency-key": randomUUID() },
  });
  expect(exported.status()).toBe(202);

  const strangerExport = await request.post(
    `/api/memorials/${memorialId}/export`,
    {
      headers: { ...cookieHeader(stranger.token), "idempotency-key": randomUUID() },
    },
  );
  expect(strangerExport.status()).toBe(404);

  // 9. And then they delete it. Confirmation is never inferred from the request
  //    having been sent.
  const unconfirmed = await request.delete(
    `/api/memorials/${memorialId}/export`,
    {
      headers: { ...cookieHeader(owner.token), "idempotency-key": randomUUID() },
      data: { confirmed: false },
    },
  );
  expect(unconfirmed.status()).toBe(422);
  // Asserting the field, not just the status: this first passed while the
  // request was being rejected for a missing header, which proved nothing
  // about the confirmation at all.
  expect(await unconfirmed.text()).toContain("confirmed");

  const deleted = await request.delete(`/api/memorials/${memorialId}/export`, {
    headers: { ...cookieHeader(owner.token), "idempotency-key": randomUUID() },
    data: { confirmed: true },
  });
  expect(deleted.status()).toBe(202);

  const afterDeletion = await client.query<{
    status: string;
    deletion_requested_at: Date | null;
    purge_after: Date | null;
  }>(
    "select status, deletion_requested_at, purge_after from memorials where id = $1",
    [memorialId],
  );
  const finalState = afterDeletion.rows[0]!;
  expect(finalState.status).toBe("pending_deletion");
  expect(finalState.deletion_requested_at).not.toBeNull();
  // The recovery period is the point: a family who asked in grief and changed
  // their mind two days later still has their relative's page.
  expect(finalState.purge_after!.getTime()).toBeGreaterThan(Date.now());
});
