// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { DrizzleMessageOutboxStore } from "../../../realtime/outbox-consumer";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date("2026-08-08T12:00:00.000Z");

runWithPostgres("real-time outbox PostgreSQL SKIP LOCKED", () => {
  const schemaName = `realtime_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let leftPool: Pool;
  let rightPool: Pool;
  let leftDatabase: ReturnType<typeof drizzle<typeof schema>>;

  const migrate = async (client: PoolClient) => {
    await client.query("begin");
    try {
      await client.query(`set local search_path to "${schemaName}"`);
      const names = (await readdir(new URL("../../../drizzle", import.meta.url)))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) {
        const source = (await readFile(new URL(`../../../drizzle/${name}`, import.meta.url), "utf8"))
          .replaceAll('"public".', `"${schemaName}".`);
        for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`create schema "${schemaName}"`);
    const migrationClient = await admin.connect();
    try { await migrate(migrationClient); } finally { migrationClient.release(); }
    const connection = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schemaName}`, max: 2 };
    leftPool = new Pool(connection);
    rightPool = new Pool(connection);
    leftDatabase = drizzle(leftPool, { schema });
  }, 30_000);

  afterAll(async () => {
    await Promise.all([leftPool?.end(), rightPool?.end()]);
    if (admin) {
      await admin.query(`drop schema if exists "${schemaName}" cascade`);
      await admin.end();
    }
  });

  it("a second pool skips a row locked by the first pool and claims it after release", async () => {
    const users = await leftDatabase.insert(schema.users).values([
      { name: "pg-realtime-a", email: `${schemaName}-a@test.example` },
      { name: "pg-realtime-b", email: `${schemaName}-b@test.example` },
    ]).returning();
    const [lowUserId, highUserId] = users.map(({ id }) => id).sort();
    const [conversation] = await leftDatabase.insert(schema.conversations).values({ lowUserId, highUserId }).returning();
    await leftDatabase.insert(schema.conversationMembers).values([
      { conversationId: conversation.id, userId: lowUserId, lowUserId, highUserId },
      { conversationId: conversation.id, userId: highUserId, lowUserId, highUserId },
    ]);
    const [message] = await leftDatabase.insert(schema.messages).values({
      conversationId: conversation.id, lowUserId, highUserId, sequence: 1,
      senderUserId: lowUserId, clientId: randomUUID(), body: "private",
    }).returning();
    const [event] = await leftDatabase.insert(schema.messageOutboxEvents).values({
      messageId: message.id, dedupeKey: `message.created:${message.id}`,
      payload: { messageId: message.id, conversationId: conversation.id, senderUserId: lowUserId, sequence: 1 },
      availableAt: NOW,
    }).returning();

    const lockClient = await leftPool.connect();
    try {
      await lockClient.query("begin");
      await lockClient.query("select id from message_outbox_events where id = $1 for update", [event.id]);
      const rightStore = new DrizzleMessageOutboxStore(drizzle(rightPool, { schema }), { clock: () => NOW });
      expect(await rightStore.claim(1)).toEqual([]);
      await lockClient.query("rollback");
    } finally {
      lockClient.release();
    }
    const leftStore = new DrizzleMessageOutboxStore(leftDatabase, { clock: () => NOW });
    expect(await leftStore.claim(1)).toMatchObject([{ id: event.id }]);
  });
});
