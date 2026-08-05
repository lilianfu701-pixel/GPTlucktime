// @vitest-environment node

import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migration = async (client: PGlite, name: string) => {
  const source = await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.exec(statement);
  }
};

describe("0003 identity pending uniqueness rollout", () => {
  const clients: PGlite[] = [];
  afterEach(async () => Promise.all(clients.splice(0).map((client) => client.close())));

  it("deterministically expires legacy duplicate identity attempts before adding the index", async () => {
    const client = new PGlite();
    clients.push(client);
    await migration(client, "0000_init_identity_profiles.sql");
    await migration(client, "0001_auth_verification.sql");
    await migration(client, "0002_auth_delivery_reliability.sql");
    const userId = "00000000-0000-4000-8000-000000000010";
    await client.exec(`insert into users (id,name,email) values ('${userId}','Legacy','legacy@example.test')`);
    await client.exec(`
      insert into verification_attempts
        (id,user_id,kind,provider,provider_reference,status,expires_at,created_at,updated_at)
      values
        ('00000000-0000-4000-8000-000000000011','${userId}','identity','vendor','old','pending',now()+interval '1 hour','2026-01-01','2026-01-01'),
        ('00000000-0000-4000-8000-000000000012','${userId}','identity','vendor','new-a','pending',now()+interval '1 hour','2026-01-02','2026-01-02'),
        ('00000000-0000-4000-8000-000000000013','${userId}','identity','vendor','new-b','pending',now()+interval '1 hour','2026-01-02','2026-01-02')
    `);

    await migration(client, "0003_identity_attempt_safety.sql");
    const result = await client.query<{ id: string; status: string }>(
      "select id,status from verification_attempts order by id",
    );
    expect(result.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000000011", status: "expired" },
      { id: "00000000-0000-4000-8000-000000000012", status: "expired" },
      { id: "00000000-0000-4000-8000-000000000013", status: "pending" },
    ]);
    await expect(client.exec(`
      insert into verification_attempts (user_id,kind,status,expires_at)
      values ('${userId}','identity','pending',now()+interval '1 hour')
    `)).rejects.toBeDefined();
    await expect(client.exec(`
      insert into verification_attempts (user_id,kind,status,expires_at)
      values
        ('${userId}','liveness','pending',now()+interval '1 hour'),
        ('${userId}','liveness','pending',now()+interval '1 hour')
    `)).resolves.toBeDefined();
  });

  it("applies 0007 by recovering old work before adding the initiating intent gate", async () => {
    const client = new PGlite();
    clients.push(client);
    for (const name of [
      "0000_init_identity_profiles.sql",
      "0001_auth_verification.sql",
      "0002_auth_delivery_reliability.sql",
      "0003_identity_attempt_safety.sql",
      "0004_password_reset_delivery.sql",
      "0005_auth_outbox_leases.sql",
      "0006_identity_session_intents.sql",
    ]) await migration(client, name);

    const userId = "00000000-0000-4000-8000-000000000020";
    await client.exec(`insert into users (id,name,email) values ('${userId}','Legacy','legacy-7@example.test')`);
    await client.exec(`
      insert into auth_notification_deliveries
        (id,kind,delivery_key,status,expires_at,lease_id,lease_expires_at)
      values
        ('00000000-0000-4000-8000-000000000021','sms_otp','legacy-processing','processing',now()+interval '1 hour',NULL,NULL)
    `);
    await client.exec(`
      insert into identity_session_intents
        (id,user_id,kind,provider,idempotency_hash,provider_idempotency_key,status,created_at,updated_at)
      values
        ('00000000-0000-4000-8000-000000000022','${userId}','identity','vendor','old-hash','old-provider-key','initiating','2026-01-01','2026-01-01'),
        ('00000000-0000-4000-8000-000000000023','${userId}','identity','vendor','new-hash','new-provider-key','initiating','2026-01-02','2026-01-02')
    `);

    await migration(client, "0007_identity_intent_gate_leases.sql");

    const deliveries = await client.query<{ status: string; last_error: string }>(
      "select status,last_error from auth_notification_deliveries where delivery_key='legacy-processing'",
    );
    expect(deliveries.rows).toEqual([{
      status: "pending",
      last_error: "NOTIFICATION_LEGACY_PROCESSING_RECOVERED",
    }]);
    const intents = await client.query<{ id: string; status: string; last_error: string | null }>(
      "select id,status,last_error from identity_session_intents order by id",
    );
    expect(intents.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000000022", status: "initiating", last_error: null },
      {
        id: "00000000-0000-4000-8000-000000000023",
        status: "compensation_pending",
        last_error: "IDENTITY_INTENT_SUPERSEDED",
      },
    ]);
    await expect(client.exec(`
      insert into identity_session_intents
        (user_id,kind,provider,idempotency_hash,provider_idempotency_key,status)
      values ('${userId}','identity','vendor','third-hash','third-provider-key','initiating')
    `)).rejects.toBeDefined();
  });
});
