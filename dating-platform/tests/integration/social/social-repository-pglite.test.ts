// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("allows a new block against a restricted and hidden profile", async () => {
    const alice = await addPerson("Hidden Block Alice");
    const bob = await addPerson("Hidden Block Bob");
    await database.update(schema.profiles).set({ status: "restricted", discoverable: false })
      .where(eq(schema.profiles.id, bob.profileId));

    await expect(repository.block(alice.userId, bob.profileId, "hidden-block-key"))
      .resolves.toEqual({ blocked: true });
  });

  it("replays a successful block after its target profile is deleted", async () => {
    const alice = await addPerson("Deleted Replay Alice");
    const bob = await addPerson("Deleted Replay Bob");
    const first = await repository.block(alice.userId, bob.profileId, "deleted-replay-key");
    await database.delete(schema.profiles).where(eq(schema.profiles.id, bob.profileId));

    await expect(repository.block(alice.userId, bob.profileId, "deleted-replay-key"))
      .resolves.toEqual(first);
    expect(await database.select().from(schema.socialActionIdempotency)).toHaveLength(1);
  });

  it("rejects a reused block key for another target after the original profile is deleted", async () => {
    const alice = await addPerson("Deleted Conflict Alice");
    const bob = await addPerson("Deleted Conflict Bob");
    const charlie = await addPerson("Deleted Conflict Charlie");
    await repository.block(alice.userId, bob.profileId, "deleted-conflict-key");
    await database.delete(schema.profiles).where(eq(schema.profiles.id, bob.profileId));

    await expect(repository.block(alice.userId, charlie.profileId, "deleted-conflict-key"))
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
    const matchEvents = await database.select().from(schema.socialOutboxEvents)
      .where(eq(schema.socialOutboxEvents.eventType, "match.created"));
    expect(match).toMatchObject({ status: "blocked" });
    expect(likes.every((like) => !like.active)).toBe(true);
    expect(favorites).toHaveLength(0);
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.revokedBefore.getTime()).toBe(now.getTime());
    expect(notifications).toHaveLength(0);
    expect(matchEvents).toHaveLength(1);
    expect(matchEvents[0]!.status).toBe("suppressed");

    for (const [method, key] of [["like", "blocked-like"], ["favorite", "blocked-favorite"], ["view", "blocked-view"]] as const) {
      await expect(repository[method](bob.userId, alice.profileId, key)).rejects.toThrow("INTERACTION_NOT_ALLOWED");
    }
    await expect(repository.withAllowedInteraction(alice.userId, bob.userId, async () => undefined))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
    await expect(repository.withAllowedInteraction(bob.userId, alice.userId, async () => undefined))
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

  it("linearizes a guarded interaction write before a concurrent block without deadlock", async () => {
    const alice = await addPerson("Guard Alice");
    const bob = await addPerson("Guard Bob");
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });

    const guarded = repository.withAllowedInteraction(alice.userId, bob.userId, async (tx) => {
      signalWriteStarted();
      await writeReleased;
      await tx.insert(schema.socialFavorites).values({
        ownerUserId: alice.userId,
        targetUserId: bob.userId,
      });
      return "written";
    });
    await writeStarted;
    let blockFinished = false;
    const blocking = repository.block(alice.userId, bob.profileId, "guard-race-block")
      .finally(() => { blockFinished = true; });
    expect(blockFinished).toBe(false);
    releaseWrite();

    await expect(guarded).resolves.toBe("written");
    await expect(blocking).resolves.toEqual({ blocked: true });
    expect(await database.select().from(schema.socialFavorites)).toEqual([]);
  });

  it("rejects a guarded interaction after either direction blocks", async () => {
    const alice = await addPerson("Guard Blocked Alice");
    const bob = await addPerson("Guard Blocked Bob");
    await repository.block(bob.userId, alice.profileId, "guard-blocked-key");

    await expect(repository.withAllowedInteraction(alice.userId, bob.userId, async () => "message"))
      .rejects.toThrow("INTERACTION_NOT_ALLOWED");
  });

  it("validates realtime ticket revocation at the exact timestamp boundary", async () => {
    const alice = await addPerson("Ticket Alice");
    const bob = await addPerson("Ticket Bob");
    await expect(repository.validateRealtimeTicket(alice.userId, bob.userId, now)).resolves.toBe(true);

    await repository.block(alice.userId, bob.profileId, "ticket-block-key");
    await expect(repository.validateRealtimeTicket(alice.userId, bob.userId, new Date(now.getTime() + 1)))
      .resolves.toBe(false);
    await repository.unblock(alice.userId, bob.profileId);

    await expect(repository.validateRealtimeTicket(alice.userId, bob.userId, new Date(now.getTime() - 1)))
      .resolves.toBe(false);
    await expect(repository.validateRealtimeTicket(alice.userId, bob.userId, now)).resolves.toBe(false);
    await expect(repository.validateRealtimeTicket(alice.userId, bob.userId, new Date(now.getTime() + 1)))
      .resolves.toBe(true);
  });

  const expectListToLinearizeBeforeBlock = async (input: {
    list: () => Promise<{ items: Array<unknown> }>;
    blockerUserId: string;
    targetProfileId: string;
    blockKey: string;
  }) => {
    type PublicProfiles = (...args: unknown[]) => Promise<Map<string, Record<string, unknown>>>;
    const internals = repository as unknown as { publicProfiles: PublicProfiles };
    const original = internals.publicProfiles.bind(repository);
    let releaseHydration!: () => void;
    let signalHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => { signalHydrationStarted = resolve; });
    const hydrationReleased = new Promise<void>((resolve) => { releaseHydration = resolve; });
    vi.spyOn(internals, "publicProfiles").mockImplementationOnce(async (...args) => {
      signalHydrationStarted();
      await hydrationReleased;
      return original(...args);
    });

    const listing = input.list();
    await hydrationStarted;
    const blocking = repository.block(input.blockerUserId, input.targetProfileId, input.blockKey);
    const blockState = await Promise.race([
      blocking.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 75)),
    ]);
    releaseHydration();
    const [page] = await Promise.all([listing, blocking]);
    expect(blockState).toBe("pending");
    expect(page.items).toHaveLength(1);
  };

  it("linearizes the matches list before a concurrent block", async () => {
    const alice = await addPerson("List Match Alice");
    const bob = await addPerson("List Match Bob");
    await repository.like(alice.userId, bob.profileId, "list-match-a");
    await repository.like(bob.userId, alice.profileId, "list-match-b");
    await expectListToLinearizeBeforeBlock({
      list: () => repository.listMatches(alice.userId, { pageSize: 50 }),
      blockerUserId: alice.userId,
      targetProfileId: bob.profileId,
      blockKey: "list-match-block",
    });
  });

  it("linearizes the likes list before a concurrent block", async () => {
    const alice = await addPerson("List Like Alice");
    const bob = await addPerson("List Like Bob");
    await repository.like(alice.userId, bob.profileId, "list-like-a");
    await expectListToLinearizeBeforeBlock({
      list: () => repository.listLikes(alice.userId, { direction: "sent", pageSize: 50 }),
      blockerUserId: alice.userId,
      targetProfileId: bob.profileId,
      blockKey: "list-like-block",
    });
  });

  it("linearizes the favorites list before a concurrent block", async () => {
    const alice = await addPerson("List Favorite Alice");
    const bob = await addPerson("List Favorite Bob");
    await repository.favorite(alice.userId, bob.profileId, "list-favorite-a");
    await expectListToLinearizeBeforeBlock({
      list: () => repository.listFavorites(alice.userId, { pageSize: 50 }),
      blockerUserId: alice.userId,
      targetProfileId: bob.profileId,
      blockKey: "list-favorite-block",
    });
  });

  it("linearizes the visitors list before a concurrent block", async () => {
    const alice = await addPerson("List Visitor Alice");
    const bob = await addPerson("List Visitor Bob");
    await repository.view(bob.userId, alice.profileId, "list-visitor-view");
    await expectListToLinearizeBeforeBlock({
      list: () => repository.listVisitors(alice.userId, { pageSize: 50 }),
      blockerUserId: alice.userId,
      targetProfileId: bob.profileId,
      blockKey: "list-visitor-block",
    });
  });

  it("continues bounded scanning when an unsafe favorite would create a short page", async () => {
    const owner = await addPerson("Scan Owner");
    const hidden = await addPerson("Scan Hidden");
    const visible = await addPerson("Scan Visible");
    now = new Date("2026-08-08T12:01:00Z");
    await repository.favorite(owner.userId, hidden.profileId, "scan-hidden-key");
    now = new Date("2026-08-08T12:00:00Z");
    await repository.favorite(owner.userId, visible.profileId, "scan-visible-key");
    await database.update(schema.profiles).set({ discoverable: false })
      .where(eq(schema.profiles.id, hidden.profileId));

    const page = await repository.listFavorites(owner.userId, { pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.profile).toMatchObject({ id: visible.profileId });
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
