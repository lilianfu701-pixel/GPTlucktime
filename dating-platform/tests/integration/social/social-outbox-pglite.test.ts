// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { SocialOutboxDispatcher } from "@/modules/social/social-outbox-dispatcher";
import { SocialRepository } from "@/modules/social/social-repository";

const SECRET = "social-outbox-test-secret-at-least-thirty-two-characters";

describe("social outbox dispatcher", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: SocialRepository;
  let dispatcher: SocialOutboxDispatcher;
  let now: Date;

  const addPerson = async (name: string) => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await database.insert(schema.profiles).values({
      userId,
      displayName: name,
      birthDate: "1992-01-01",
      genderCode: "woman",
      countryCode: "US",
      timeZone: "UTC",
      city: "Seattle",
      bio: "Public bio",
      status: "active",
      discoverable: true,
    }).returning({ id: schema.profiles.id });
    await database.insert(schema.profilePreferences).values({ userId, languageCodes: ["en"] });
    await database.insert(schema.privacySettings).values({ userId, locationPrecision: "country" });
    await database.insert(schema.profilePhotos).values({
      userId,
      profileId,
      objectKey: `outbox/${userId}/${profileId}.jpg`,
      moderationStatus: "approved",
      position: 0,
    });
    return { userId, profileId };
  };

  const createPendingMatch = async (prefix: string) => {
    const alice = await addPerson(`${prefix} Alice`);
    const bob = await addPerson(`${prefix} Bob`);
    await repository.like(alice.userId, bob.profileId, `${prefix}-like-a`);
    await repository.like(bob.userId, alice.profileId, `${prefix}-like-b`);
    const [event] = await database.select().from(schema.socialOutboxEvents);
    return { alice, bob, event: event! };
  };

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    now = new Date("2026-08-08T12:00:00Z");
    repository = new SocialRepository(database, {
      clock: () => now,
      cursorSecret: SECRET,
      idempotencySecret: SECRET,
    });
    dispatcher = new SocialOutboxDispatcher(database, { clock: () => now, sendTimeoutMs: 25 });
  });

  afterEach(async () => client.close());

  it("never calls the sender when block commits before dispatch", async () => {
    const { alice, bob, event } = await createPendingMatch("Block First");
    await repository.block(alice.userId, bob.profileId, "block-first-key");
    const sender = vi.fn(async () => undefined);

    await expect(dispatcher.dispatch(event.id, sender)).resolves.toEqual({ status: "suppressed" });
    expect(sender).not.toHaveBeenCalled();
    const [stored] = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.id, event.id));
    expect(stored).toMatchObject({
      status: "suppressed",
      suppressionReason: "pair_blocked",
      suppressedAt: now,
      leaseId: null,
      leaseExpiresAt: null,
    });
  });

  it("lets a dispatcher holding pair locks publish before a concurrent block", async () => {
    const { alice, bob, event } = await createPendingMatch("Dispatch First");
    let releaseSender!: () => void;
    let signalSenderStarted!: () => void;
    const senderStarted = new Promise<void>((resolve) => { signalSenderStarted = resolve; });
    const senderReleased = new Promise<void>((resolve) => { releaseSender = resolve; });
    const sender = vi.fn(async (message: { dedupeKey: string }) => {
      expect(message.dedupeKey).toBe(event.dedupeKey);
      signalSenderStarted();
      await senderReleased;
    });

    const dispatching = dispatcher.dispatch(event.id, sender);
    await senderStarted;
    let blockFinished = false;
    const blocking = repository.block(alice.userId, bob.profileId, "dispatch-first-block")
      .finally(() => { blockFinished = true; });
    expect(blockFinished).toBe(false);
    releaseSender();

    await expect(dispatching).resolves.toEqual({ status: "published" });
    await expect(blocking).resolves.toEqual({ blocked: true });
    expect(sender).toHaveBeenCalledOnce();
    const [stored] = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.id, event.id));
    expect(stored).toMatchObject({ status: "published", publishedAt: now });
  });

  it("bounds sender time and leaves a retryable failed event", async () => {
    const { event } = await createPendingMatch("Timeout");
    const sender = vi.fn(() => new Promise<void>(() => undefined));

    await expect(dispatcher.dispatch(event.id, sender)).resolves.toEqual({ status: "failed" });
    const [stored] = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.id, event.id));
    expect(stored).toMatchObject({ status: "failed", attempts: 1, leaseId: null, leaseExpiresAt: null });
  });

  it("does not send an event before its available time", async () => {
    const { event } = await createPendingMatch("Future Due");
    await database.update(schema.socialOutboxEvents).set({
      availableAt: new Date(now.getTime() + 60_000),
    }).where(eq(schema.socialOutboxEvents.id, event.id));
    const sender = vi.fn(async () => undefined);

    await expect(dispatcher.dispatch(event.id, sender)).resolves.toEqual({ status: "not_due" });
    expect(sender).not.toHaveBeenCalled();
    const [stored] = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.id, event.id));
    expect(stored).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("suppresses an orphaned match event instead of leaving it pending", async () => {
    const { event } = await createPendingMatch("Orphan");
    await database.delete(schema.socialMatches).where(eq(schema.socialMatches.id, event.aggregateId));
    const sender = vi.fn(async () => undefined);

    await expect(dispatcher.dispatch(event.id, sender)).resolves.toEqual({ status: "suppressed" });
    expect(sender).not.toHaveBeenCalled();
    const [stored] = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.id, event.id));
    expect(stored).toMatchObject({ status: "suppressed", suppressionReason: "match_unavailable" });
  });

  it("rejects processing events without a complete lease", async () => {
    const { event } = await createPendingMatch("Lease Check");
    await expect(client.query(
      "update social_outbox_events set status='processing' where id=$1",
      [event.id],
    )).rejects.toThrow(/social_outbox_lease_consistency_check/);
  });
});
