// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migration = async (client: PGlite, name: string) => {
  const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.exec(statement);
  }
};

describe("0020 discovery recovery rollout", () => {
  const clients: PGlite[] = [];
  afterEach(async () => Promise.all(clients.splice(0).map((client) => client.close())));

  it("adds nullable build leases and versions legacy saved searches safely", async () => {
    const client = new PGlite();
    clients.push(client);
    const migrationNames = (await readdir(new URL("../../../drizzle", import.meta.url)))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0020_")
      .sort();
    for (const name of migrationNames) await migration(client, name);

    const ownerUserId = "00000000-0000-4000-8000-000000000401";
    await client.query(
      "insert into users (id,name,email) values ($1,'Lease Owner','lease-owner@example.test')",
      [ownerUserId],
    );
    await client.query(`
      insert into discovery_snapshots
        (id,owner_user_id,mode,filter_fingerprint,ranking_version,status,item_count,truncated,expires_at)
      values
        ('00000000-0000-4000-8000-000000000402',$1,'recommended','legacy-building-a','discovery-v1','building',0,false,now()+interval '15 minutes'),
        ('00000000-0000-4000-8000-000000000403',$1,'nearby','legacy-building-b','discovery-v1','building',0,false,now()+interval '15 minutes')
    `, [ownerUserId]);
    await client.query(`
      insert into saved_searches (id,user_id,name,filters)
      values
        ('00000000-0000-4000-8000-000000000404',$1,'Legacy valid','{"mode":"nearby"}'::jsonb),
        ('00000000-0000-4000-8000-000000000405',$1,'Legacy coordinates','{"mode":"nearby","latitude":47.6,"longitude":-122.3}'::jsonb)
    `, [ownerUserId]);

    await migration(client, "0020_discovery_snapshot_recovery.sql");

    const snapshots = await client.query<{
      build_lease_id: string | null;
      build_lease_expires_at: Date | null;
    }>("select build_lease_id,build_lease_expires_at from discovery_snapshots order by id");
    expect(snapshots.rows).toEqual([
      { build_lease_id: null, build_lease_expires_at: null },
      { build_lease_id: null, build_lease_expires_at: null },
    ]);
    const saved = await client.query<{ schema_version: number }>(
      "select schema_version from saved_searches order by id",
    );
    expect(saved.rows).toEqual([{ schema_version: 1 }, { schema_version: 1 }]);
    const inserted = await client.query<{ schema_version: number }>(`
      insert into saved_searches (user_id,name,filters)
      values ($1,'New default','{"mode":"recommended"}'::jsonb)
      returning schema_version
    `, [ownerUserId]);
    expect(inserted.rows).toEqual([{ schema_version: 1 }]);
  });
});
