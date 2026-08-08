// @vitest-environment node

import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { publicDiscoveryFilterSchema } from "@/modules/discovery/discovery-types";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import { filterFingerprint, RANKING_VERSION } from "@/modules/discovery/ranking";

const migration = async (client: PGlite, name: string) => {
  const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.exec(statement);
  }
};

const migrationsThrough0017 = [
  "0000_init_identity_profiles.sql",
  "0001_auth_verification.sql",
  "0002_auth_delivery_reliability.sql",
  "0003_identity_attempt_safety.sql",
  "0004_password_reset_delivery.sql",
  "0005_auth_outbox_leases.sql",
  "0006_identity_session_intents.sql",
  "0007_identity_intent_gate_leases.sql",
  "0008_profile_media_review.sql",
  "0009_profile_drafts_timezones.sql",
  "0010_profile_media_quota_slots.sql",
  "0011_immutable_media_review_results.sql",
  "0012_profile_photo_user_removal.sql",
  "0013_online_quota_and_timezone_safety.sql",
  "0014_durable_media_finalization.sql",
  "0015_media_cleanup_leases.sql",
  "0016_safe_discovery.sql",
  "0017_materialized_discovery_snapshots.sql",
] as const;

describe("0018/0019 discovery snapshot forward migration", () => {
  const clients: PGlite[] = [];
  afterEach(async () => Promise.all(clients.splice(0).map((client) => client.close())));

  it("backfills legacy materialized snapshots and keeps them readable", async () => {
    const client = new PGlite();
    clients.push(client);
    for (const name of migrationsThrough0017) await migration(client, name);

    const ownerUserId = "00000000-0000-4000-8000-000000000101";
    const candidateUserId = "00000000-0000-4000-8000-000000000102";
    const ownerProfileId = "00000000-0000-4000-8000-000000000201";
    const candidateProfileId = "00000000-0000-4000-8000-000000000202";
    const populatedSnapshotId = "00000000-0000-4000-8000-000000000301";
    const emptySnapshotId = "00000000-0000-4000-8000-000000000302";
    const filters = publicDiscoveryFilterSchema.parse({});
    const emptyFilters = publicDiscoveryFilterSchema.parse({ minimumAge: 19 });

    await client.query(
      "insert into users (id,name,email) values ($1,'Owner','owner-migration@example.test'),($2,'Candidate','candidate-migration@example.test')",
      [ownerUserId, candidateUserId],
    );
    await client.query(`
      insert into profiles
        (id,user_id,display_name,birth_date,gender_code,relationship_goal_code,country_code,city,bio,status,discoverable,publish_requested,time_zone,created_at)
      values
        ($1,$2,'Owner','1990-01-01','man','long_term','US','Seattle','Owner bio','active',true,true,'UTC','2026-01-01'),
        ($3,$4,'Candidate','1992-01-01','woman','long_term','US','Seattle','Candidate bio','active',true,true,'UTC','2026-01-02')
    `, [ownerProfileId, ownerUserId, candidateProfileId, candidateUserId]);
    await client.query(
      "insert into profile_preferences (user_id,language_codes,relationship_goal_codes) values ($1,array['en'],array['long_term']),($2,array['en'],array['long_term'])",
      [ownerUserId, candidateUserId],
    );
    await client.query(
      "insert into privacy_settings (user_id,location_precision) values ($1,'city'),($2,'approximate')",
      [ownerUserId, candidateUserId],
    );
    await client.query(`
      insert into profile_photos
        (user_id,profile_id,object_key,position,moderation_status,width,height)
      values ($1,$2,'profile-review/migrated-candidate.jpg',0,'approved',800,1000)
    `, [candidateUserId, candidateProfileId]);
    await client.query(`
      insert into discovery_snapshots
        (id,owner_user_id,mode,filter_fingerprint,ranking_version,expires_at,created_at)
      values
        ($1,$2,'recommended',$3,$4,'2026-08-09T00:00:00Z','2026-08-08T00:00:00Z'),
        ($5,$2,'recommended',$6,$4,'2026-08-09T00:00:00Z','2026-08-08T00:01:00Z')
    `, [
      populatedSnapshotId,
      ownerUserId,
      filterFingerprint(filters),
      RANKING_VERSION,
      emptySnapshotId,
      filterFingerprint(emptyFilters),
    ]);
    await client.query(`
      insert into discovery_snapshot_items
        (snapshot_id,ordinal,candidate_user_id,candidate_profile_id,score,reasons)
      values ($1,0,$2,$3,85,array['shared_interests'])
    `, [populatedSnapshotId, candidateUserId, candidateProfileId]);

    await migration(client, "0018_discovery_snapshot_item_count.sql");
    await migration(client, "0019_bounded_discovery_snapshots.sql");

    const migrated = await client.query<{
      id: string;
      item_count: number;
      status: string;
      truncated: boolean;
    }>("select id,item_count,status,truncated from discovery_snapshots order by id");
    expect(migrated.rows).toEqual([
      { id: populatedSnapshotId, item_count: 1, status: "ready", truncated: false },
      { id: emptySnapshotId, item_count: 0, status: "ready", truncated: false },
    ]);

    await migration(client, "0020_discovery_snapshot_recovery.sql");

    const database = drizzle(client, { schema });
    const repository = new DiscoveryRepository(database, {
      clock: () => new Date("2026-08-08T12:00:00Z"),
      cursorSecret: "migration-test-cursor-secret-at-least-32-characters",
    });
    const result = await repository.discover(ownerUserId, filters);
    expect(result.items.map(({ id }) => id)).toEqual([candidateProfileId]);
    const emptyResult = await repository.discover(ownerUserId, emptyFilters);
    expect(emptyResult.items).toEqual([]);

    const futureSnapshotId = "00000000-0000-4000-8000-000000000303";
    await client.query(`
      insert into discovery_snapshots
        (id,owner_user_id,mode,filter_fingerprint,ranking_version,item_count,expires_at,created_at)
      values ($1,$2,'new','future-default',$3,0,'2026-08-09T00:00:00Z','2026-08-08T00:02:00Z')
    `, [futureSnapshotId, ownerUserId, RANKING_VERSION]);
    const future = await client.query<{ status: string }>(
      "select status from discovery_snapshots where id=$1",
      [futureSnapshotId],
    );
    expect(future.rows).toEqual([{ status: "building" }]);
  });
});
