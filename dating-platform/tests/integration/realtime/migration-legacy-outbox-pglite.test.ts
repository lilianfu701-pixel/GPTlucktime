// @vitest-environment node

import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("0029 real-time delivery migration", () => {
  const clients: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("backfills legacy failed rows before installing the failure metadata constraint", async () => {
    const client = new PGlite();
    clients.push(client);
    await client.exec(`
      CREATE TABLE message_outbox_events (
        id uuid PRIMARY KEY,
        status varchar(20) NOT NULL,
        created_at timestamp with time zone NOT NULL,
        lease_id uuid,
        lease_expires_at timestamp with time zone
      );
      INSERT INTO message_outbox_events (id, status, created_at, lease_id, lease_expires_at)
      VALUES (
        '00000000-0000-4000-8000-000000000001',
        'failed',
        '2026-08-08T12:00:00.000Z',
        '00000000-0000-4000-8000-000000000002',
        '2026-08-08T13:00:00.000Z'
      );
    `);

    const migration = await readFile(new URL("../../../drizzle/0029_realtime_delivery.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await client.exec(statement);
    }

    const result = await client.query<{
      last_error_code: string;
      failed_at: string;
      lease_id: string | null;
      lease_expires_at: string | null;
    }>("SELECT last_error_code, failed_at, lease_id, lease_expires_at FROM message_outbox_events");
    expect(result.rows).toEqual([expect.objectContaining({
      last_error_code: "LEGACY_FAILED",
      lease_id: null,
      lease_expires_at: null,
    })]);
    expect(new Date(result.rows[0]!.failed_at).toISOString()).toBe("2026-08-08T12:00:00.000Z");

    await expect(client.exec(`
      INSERT INTO message_outbox_events (id, status, created_at)
      VALUES ('00000000-0000-4000-8000-000000000003', 'failed', now())
    `)).rejects.toThrow();
  });
});
