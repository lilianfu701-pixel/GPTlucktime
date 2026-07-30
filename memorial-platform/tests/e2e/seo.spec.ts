import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";

/**
 * What a crawler actually receives.
 *
 * The unit tests decide whether a memorial *should* be listed; this one checks
 * the bytes that leave the server. A sitemap is the one surface that hands a
 * crawler a list of addresses it would otherwise have no way to find, so a
 * private memorial appearing in it is not a cosmetic bug — it is the disclosure
 * the privacy settings exist to prevent, and it would happen silently.
 */

function fromEnvFile(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  const raw = readFileSync(".env.local", "utf8");
  const match = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match?.[1]) {
    throw new Error(`${key} is required to set up sitemap fixtures`);
  }
  return match[1].trim();
}

type Fixture = { slug: string; label: string };

const listed: Fixture = { slug: `sitemap-public-${randomUUID().slice(0, 8)}`, label: "public and indexable" };
const unlisted: Fixture = { slug: `sitemap-unlisted-${randomUUID().slice(0, 8)}`, label: "unlisted" };
const noIndex: Fixture = { slug: `sitemap-noindex-${randomUUID().slice(0, 8)}`, label: "public but not indexable" };
const draft: Fixture = { slug: `sitemap-draft-${randomUUID().slice(0, 8)}`, label: "still a draft" };

let client: pg.Client;
let ownerId: string;

test.beforeAll(async () => {
  client = new pg.Client({ connectionString: fromEnvFile("DATABASE_URL") });
  await client.connect();

  const owner = await client.query<{ id: string }>(
    "insert into users (display_name) values ($1) returning id",
    [`Sitemap owner ${randomUUID().slice(0, 8)}`],
  );
  ownerId = owner.rows[0]!.id;

  const insert = async (
    fixture: Fixture,
    visibility: string,
    status: string,
    indexable: boolean,
  ): Promise<void> => {
    const person = await client.query<{ id: string }>(
      "insert into deceased_people default values returning id",
    );
    await client.query(
      `insert into memorials
         (deceased_person_id, slug, status, visibility, search_engine_indexable,
          owner_user_id, published_at, creation_idempotency_key)
       values ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [
        person.rows[0]!.id,
        fixture.slug,
        status,
        visibility,
        indexable,
        ownerId,
        randomUUID(),
      ],
    );
  };

  await insert(listed, "public", "published", true);
  await insert(unlisted, "unlisted", "published", true);
  await insert(noIndex, "public", "published", false);
  await insert(draft, "public", "draft", true);
});

test.afterAll(async () => {
  const people = await client.query<{ deceased_person_id: string }>(
    "delete from memorials where owner_user_id = $1 returning deceased_person_id",
    [ownerId],
  );
  for (const row of people.rows) {
    await client.query("delete from deceased_people where id = $1", [
      row.deceased_person_id,
    ]);
  }
  await client.query("delete from users where id = $1", [ownerId]);
  await client.end();
});

test.describe("sitemap", () => {
  test("lists a public, indexable memorial", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(listed.slug);
  });

  for (const fixture of [unlisted, noIndex, draft]) {
    test(`never lists a memorial that is ${fixture.label}`, async ({ request }) => {
      const body = await (await request.get("/sitemap.xml")).text();
      expect(body).not.toContain(fixture.slug);
    });
  }

  test("is served as XML a crawler can parse", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.headers()["content-type"]).toContain("xml");

    const body = await response.text();
    expect(body).toContain("<urlset");
    // Every opening tag is closed: a truncated sitemap is discarded silently.
    expect(body.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});

test.describe("robots.txt", () => {
  test("points crawlers at the sitemap", async ({ request }) => {
    const body = await (await request.get("/robots.txt")).text();
    expect(body).toMatch(/Sitemap:\s*\S+\/sitemap\.xml/);
  });

  test("keeps crawlers out of the API and staff surfaces", async ({ request }) => {
    const body = await (await request.get("/robots.txt")).text();
    for (const path of ["/api/", "/*/admin", "/*/sign-in"]) {
      expect(body).toContain(`Disallow: ${path}`);
    }
  });
});
