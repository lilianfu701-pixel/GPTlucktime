// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { SocialRepository } from "@/modules/social/social-repository";

const CURSOR_SECRET = "social-cursor-secret-at-least-thirty-two-characters";
const IDEMPOTENCY_SECRET = "social-idempotency-secret-at-least-thirty-two";

describe("social repository", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: SocialRepository;
  let now: Date;

  const addPerson = async (name: string, options: { showVisitors?: boolean } = {}) => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await database.insert(schema.profiles).values({
      userId,
      displayName: name,
      birthDate: "1992-01-01",
      genderCode: "woman",
      relationshipGoalCode: "long_term",
      countryCode: "US",
      timeZone: "UTC",
      city: "Seattle",
      bio: "Public bio",
      status: "active",
      discoverable: true,
      publishRequested: true,
    }).returning({ id: schema.profiles.id });
    await database.insert(schema.profilePreferences).values({
      userId,
      languageCodes: ["en"],
      relationshipGoalCodes: ["long_term"],
    });
    await database.insert(schema.privacySettings).values({
      userId,
      showProfileVisitors: options.showVisitors ?? true,
      locationPrecision: "country",
    });
    await database.insert(schema.profilePhotos).values({
      userId,
      profileId,
      objectKey: `social/${userId}/${profileId}.jpg`,
      moderationStatus: "approved",
      position: 0,
      width: 800,
      height: 1000,
    });
    return { userId, profileId };
  };

  beforeEach(async () => {
    client = new PGlite();
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    now = new Date("2026-08-08T12:00:00Z");
    repository = new SocialRepository(database, {
      clock: () => now,
      cursorSecret: CURSOR_SECRET,
      idempotencySecret: IDEMPOTENCY_SECRET,
    });
  });

  afterEach(async () => client.close());

  it("creates exactly one canonical match and one outbox event for reciprocal likes", async () => {
    const alice = await addPerson("Alice");
    const bob = await addPerson("Bob");

    expect((await repository.like(alice.userId, bob.profileId, "alice-like-bob")).matched).toBe(false);
    expect((await repository.like(bob.userId, alice.profileId, "bob-like-alice")).matched).toBe(true);

    const matches = await database.select().from(schema.socialMatches);
    const outbox = await database.select().from(schema.socialOutboxEvents);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      lowUserId: [alice.userId, bob.userId].sort()[0],
      highUserId: [alice.userId, bob.userId].sort()[1],
      status: "active",
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ eventType: "match.created", status: "pending" });
  });

  it("serializes concurrent reciprocal likes without duplicate matches or events", async () => {
    const alice = await addPerson("Concurrent Alice");
    const bob = await addPerson("Concurrent Bob");

    await Promise.all([
      repository.like(alice.userId, bob.profileId, "concurrent-a-b"),
      repository.like(bob.userId, alice.profileId, "concurrent-b-a"),
    ]);

    expect(await database.select().from(schema.socialMatches)).toHaveLength(1);
    expect(await database.select().from(schema.socialOutboxEvents)).toHaveLength(1);
  });

  it("replays the same idempotency key and rejects reuse for another action or target", async () => {
    const alice = await addPerson("Idempotent Alice");
    const bob = await addPerson("Idempotent Bob");
    const charlie = await addPerson("Idempotent Charlie");

    const first = await repository.like(alice.userId, bob.profileId, "stable-social-key");
    const replay = await repository.like(alice.userId, bob.profileId, "stable-social-key");
    expect(replay).toEqual(first);
    expect(await database.select().from(schema.socialLikes)).toHaveLength(1);
    await expect(repository.favorite(alice.userId, bob.profileId, "stable-social-key"))
      .rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(repository.like(alice.userId, charlie.profileId, "stable-social-key"))
      .rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("rejects self interactions", async () => {
    const alice = await addPerson("Self Alice");
    await expect(repository.like(alice.userId, alice.profileId, "self-like-key"))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
    await expect(repository.favorite(alice.userId, alice.profileId, "self-favorite-key"))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
    await expect(repository.view(alice.userId, alice.profileId, "self-view-key"))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
  });

  it("atomically blocks both directions, hides the match, revokes tickets, and emits no block notification", async () => {
    const alice = await addPerson("Block Alice");
    const bob = await addPerson("Block Bob");
    await repository.like(alice.userId, bob.profileId, "block-like-a");
    await repository.like(bob.userId, alice.profileId, "block-like-b");
    await repository.favorite(alice.userId, bob.profileId, "block-favorite-a");

    await repository.block(alice.userId, bob.profileId, "block-action-key");

    const [match] = await database.select().from(schema.socialMatches);
    const likes = await database.select().from(schema.socialLikes);
    const favorites = await database.select().from(schema.socialFavorites);
    const revocations = await database.select().from(schema.realtimePairRevocations);
    const notifications = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.eventType, "user.blocked"));
    expect(match).toMatchObject({ status: "blocked" });
    expect(likes.every((like) => !like.active)).toBe(true);
    expect(favorites).toHaveLength(0);
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.revokedBefore.getTime()).toBe(now.getTime());
    expect(notifications).toHaveLength(0);

    for (const [method, key] of [["like", "blocked-like"], ["favorite", "blocked-favorite"], ["view", "blocked-view"]] as const) {
      await expect(repository[method](bob.userId, alice.profileId, key)).rejects.toThrow("INTERACTION_NOT_ALLOWED");
    }
    await expect(repository.assertInteractionAllowed(alice.userId, bob.userId))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
    await expect(repository.assertInteractionAllowed(bob.userId, alice.userId))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");

    expect((await repository.listMatches(bob.userId, { pageSize: 50 })).items).toEqual([]);
    expect((await repository.listLikes(bob.userId, { direction: "received", pageSize: 50 })).items).toEqual([]);
  });

  it("does not create a visible match when a block races a like and unblock does not revive old state", async () => {
    const alice = await addPerson("Race Alice");
    const bob = await addPerson("Race Bob");
    await repository.like(alice.userId, bob.profileId, "race-like-a");
    await Promise.allSettled([
      repository.like(bob.userId, alice.profileId, "race-like-b"),
      repository.block(alice.userId, bob.profileId, "race-block"),
    ]);
    expect((await repository.listMatches(alice.userId, { pageSize: 50 })).items).toEqual([]);

    await repository.unblock(alice.userId, bob.profileId);
    expect((await repository.listMatches(alice.userId, { pageSize: 50 })).items).toEqual([]);
    expect((await repository.listLikes(alice.userId, { direction: "sent", pageSize: 50 })).items).toEqual([]);
  });

  it("honors visitor privacy, aggregates duplicate views, excludes self and blocks, and returns safe profiles", async () => {
    const owner = await addPerson("Visitor Owner");
    const visible = await addPerson("Visible Visitor");
    const privateVisitor = await addPerson("Private Visitor", { showVisitors: false });
    await repository.view(visible.userId, owner.profileId, "view-owner-1");
    now = new Date("2026-08-08T12:05:00Z");
    await repository.view(visible.userId, owner.profileId, "view-owner-2");
    await repository.view(privateVisitor.userId, owner.profileId, "view-owner-private");

    const beforeBlock = await repository.listVisitors(owner.userId, { pageSize: 50 });
    expect(beforeBlock.items).toHaveLength(1);
    expect(beforeBlock.items[0]).toMatchObject({ viewCount: 2, profile: { id: visible.profileId } });
    expect(beforeBlock.items[0]!.profile).not.toHaveProperty("userId");
    expect(beforeBlock.items[0]!.profile).not.toHaveProperty("birthDate");
    expect(beforeBlock.items[0]!.profile).not.toHaveProperty("city");
    expect(beforeBlock.items[0]!.profile.photos).toHaveLength(1);

    await repository.block(owner.userId, visible.profileId, "visitor-block");
    expect((await repository.listVisitors(owner.userId, { pageSize: 50 })).items).toEqual([]);
    expect(await database.select().from(schema.profileViews).where(or(
      and(eq(schema.profileViews.viewerUserId, owner.userId), eq(schema.profileViews.viewedUserId, owner.userId)),
      and(eq(schema.profileViews.viewerUserId, visible.userId), eq(schema.profileViews.viewedUserId, visible.userId)),
    ))).toEqual([]);
  });
});
