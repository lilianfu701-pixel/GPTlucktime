import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";

/**
 * Two families connect a tree, over real HTTP.
 *
 * The assertion that matters is the last one: a family who links their relative
 * to somebody else's private memorial gets a tree with a hole in it, not a
 * name. Everything before it exists to build a situation where that could
 * actually leak.
 */

const SESSION_COOKIE_NAME = "memorial_session";

function fromEnvFile(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  const raw = readFileSync(".env.local", "utf8");
  const match = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match?.[1]) throw new Error(`${key} is required for the tree fixtures`);
  return match[1].trim();
}

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
    const people = await client.query<{ id: string }>(
      "select id from family_people where created_by_user_id = any($1)",
      [createdUserIds],
    );
    const personIds = people.rows.map((row) => row.id);
    if (personIds.length > 0) {
      await client.query(
        "delete from family_links where person_a_id = any($1) or person_b_id = any($1)",
        [personIds],
      );
      await client.query("delete from family_people where id = any($1)", [personIds]);
    }

    const owned = await client.query<{ id: string; deceased_person_id: string }>(
      "select id, deceased_person_id from memorials where owner_user_id = any($1)",
      [createdUserIds],
    );
    const ids = owned.rows.map((row) => row.id);
    if (ids.length > 0) {
      await client.query("delete from search_documents where memorial_id = any($1)", [ids]);
      await client.query("delete from audit_logs where resource_id = any($1)", [ids]);
      await client.query("delete from outbox_events where aggregate_id = any($1)", [ids]);
      await client.query("delete from memorials where id = any($1)", [ids]);
      await client.query("delete from deceased_people where id = any($1)", [
        owned.rows.map((row) => row.deceased_person_id),
      ]);
    }
    await client.query("delete from audit_logs where actor_user_id = any($1)", [createdUserIds]);
    await client.query("delete from users where id = any($1)", [createdUserIds]);
  }
  await client.end();
});

async function signedInUser(label: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "insert into users (display_name) values ($1) returning id",
    [`${label} ${randomUUID().slice(0, 8)}`],
  );
  createdUserIds.push(rows[0]!.id);

  const token = randomBytes(32).toString("hex");
  await client.query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')",
    [rows[0]!.id, hashSessionToken(token, fromEnvFile("SESSION_SECRET"))],
  );
  return token;
}

function cookie(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function makeMemorial(
  request: APIRequestContext,
  token: string,
  name: string,
  visibility: "public" | "invite_only",
): Promise<{ memorialId: string; personId: string }> {
  const created = await request.post("/api/memorials", {
    headers: { ...cookie(token), "idempotency-key": randomUUID() },
    data: {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: name },
      visibility,
    },
  });
  expect(created.status()).toBe(201);
  const memorialId = ((await created.json()) as { data: { memorialId: string } })
    .data.memorialId;

  await client.query(
    "update memorials set status = 'published', published_at = now() where id = $1",
    [memorialId],
  );

  const added = await request.post(`/api/memorials/${memorialId}/family`, {
    headers: cookie(token),
  });
  expect(added.status()).toBe(201);
  const personId = ((await added.json()) as { data: { personId: string } }).data
    .personId;

  return { memorialId, personId };
}

test("a private relative shows as a gap, never as a name", async ({ request }) => {
  const mine = await signedInUser("Mine");
  const theirs = await signedInUser("Theirs");

  const childName = `Child${randomUUID().slice(0, 6)}`;
  const parentName = `Parent${randomUUID().slice(0, 6)}`;

  const child = await makeMemorial(request, mine, childName, "public");
  const parent = await makeMemorial(request, theirs, parentName, "invite_only");

  // The other family proposes; mine confirms. Both sides agreed, which is
  // exactly the situation where a naive traversal would hand over the name.
  const proposed = await request.post("/api/family/links", {
    headers: cookie(theirs),
    data: { kind: "parent", parentId: parent.personId, childId: child.personId },
  });
  expect(proposed.status()).toBe(201);
  const proposal = (await proposed.json()) as {
    data: { linkId: string; status: string };
  };
  expect(proposal.data.status).toBe("proposed");

  const confirmed = await request.post(
    `/api/family/links/${proposal.data.linkId}`,
    { headers: cookie(mine), data: { decision: "confirm" } },
  );
  expect(confirmed.status()).toBe(200);

  const tree = await request.get(`/api/memorials/${child.memorialId}/family`, {
    headers: cookie(mine),
  });
  expect(tree.status()).toBe(200);

  const body = await tree.text();
  // The shape is honest: two nodes and the edge between them.
  const parsed = JSON.parse(body) as {
    data: { nodes: { visible: boolean }[]; edges: unknown[] };
  };
  expect(parsed.data.nodes).toHaveLength(2);
  expect(parsed.data.edges).toHaveLength(1);
  expect(parsed.data.nodes.filter((node) => !node.visible)).toHaveLength(1);

  // And nothing about the private memorial is in the response at all.
  expect(body).not.toContain(parentName);
  expect(body).not.toContain(parent.personId);
  expect(body).not.toContain(parent.memorialId);
});

test("the tree endpoint is not a side door into a private memorial", async ({
  request,
}) => {
  const owner = await signedInUser("Owner");
  const stranger = await signedInUser("Stranger");
  const hidden = await makeMemorial(
    request,
    owner,
    `Hidden${randomUUID().slice(0, 6)}`,
    "invite_only",
  );

  const asStranger = await request.get(
    `/api/memorials/${hidden.memorialId}/family`,
    { headers: cookie(stranger) },
  );
  const madeUp = await request.get(
    `/api/memorials/${randomUUID()}/family`,
    { headers: cookie(stranger) },
  );

  // The same answer as for a memorial that never existed.
  expect(asStranger.status()).toBe(404);
  expect(madeUp.status()).toBe(asStranger.status());
});

test("a stranger cannot answer a proposal between two other families", async ({
  request,
}) => {
  const mine = await signedInUser("Mine");
  const theirs = await signedInUser("Theirs");
  const outsider = await signedInUser("Outsider");

  const child = await makeMemorial(request, mine, `C${randomUUID().slice(0, 6)}`, "public");
  const parent = await makeMemorial(request, theirs, `P${randomUUID().slice(0, 6)}`, "public");

  const proposed = await request.post("/api/family/links", {
    headers: cookie(theirs),
    data: { kind: "parent", parentId: parent.personId, childId: child.personId },
  });
  const linkId = ((await proposed.json()) as { data: { linkId: string } }).data
    .linkId;

  const answered = await request.post(`/api/family/links/${linkId}`, {
    headers: cookie(outsider),
    data: { decision: "confirm" },
  });

  // 404, not 403: a stranger must not learn two families are being connected.
  expect(answered.status()).toBe(404);
});
