// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { publicDiscoveryFilterSchema } from "@/modules/discovery/discovery-types";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import {
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
  filterFingerprint,
  RANKING_VERSION,
} from "@/modules/discovery/ranking";

const CURSOR_SECRET = "cursor-secret-that-is-at-least-32-characters";

describe("discovery repository", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: DiscoveryRepository;
  let viewerId: string;
  let now: Date;

  const addPerson = async (input: {
    email: string;
    displayName: string;
    birthDate?: string;
    genderCode?: string;
    countryCode?: string;
    city?: string;
    privacy?: "hidden" | "country" | "city" | "approximate";
    createdAt?: Date;
  }) => {
    const [{ id: userId }] = await database.insert(schema.users).values({
      name: input.displayName,
      email: input.email,
    }).returning({ id: schema.users.id });
    const [{ id: profileId }] = await database.insert(schema.profiles).values({
      userId,
      displayName: input.displayName,
      birthDate: input.birthDate ?? "1992-01-01",
      genderCode: input.genderCode ?? "woman",
      relationshipGoalCode: "long_term",
      countryCode: input.countryCode ?? "US",
      timeZone: "UTC",
      city: input.city ?? "Seattle",
      bio: "Public bio",
      status: "active",
      discoverable: true,
      publishRequested: true,
      createdAt: input.createdAt ?? new Date("2026-08-08T00:00:00Z"),
    }).returning({ id: schema.profiles.id });
    await database.insert(schema.profilePreferences).values({
      userId,
      minimumAge: 18,
      maximumAge: 100,
      genderCodes: [],
      languageCodes: ["en"],
      relationshipGoalCodes: ["long_term"],
    });
    await database.insert(schema.privacySettings).values({
      userId,
      showOnlineStatus: true,
      locationPrecision: input.privacy ?? "approximate",
    });
    await database.insert(schema.profilePhotos).values({
      userId,
      profileId,
      objectKey: `profile-review/${userId}/${profileId}.jpg`,
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
    repository = new DiscoveryRepository(database, {
      clock: () => now,
      cursorSecret: CURSOR_SECRET,
      disabledCountryCodes: ["CA"],
    });
    ({ userId: viewerId } = await addPerson({
      email: "viewer@example.test",
      displayName: "Viewer",
      birthDate: "1990-01-01",
      genderCode: "man",
      privacy: "city",
    }));
  });

  afterEach(async () => client.close());

  it("hard-filters before ranking, applies every mode, and exposes only public fields", async () => {
    const visible = await addPerson({
      email: "visible@example.test", displayName: "Visible", privacy: "approximate", city: "Private City",
    });
    const blocked = await addPerson({ email: "blocked@example.test", displayName: "Blocked" });
    await database.insert(schema.userBlocks).values({ blockerUserId: blocked.userId, blockedUserId: viewerId });
    await database.insert(schema.sessions).values({
      userId: visible.userId,
      token: "visible-online-token",
      expiresAt: new Date("2026-08-09T12:00:00Z"),
      updatedAt: new Date("2026-08-08T11:55:00Z"),
    });
    await database.insert(schema.verificationAttempts).values({
      userId: visible.userId,
      kind: "identity",
      status: "approved",
      expiresAt: new Date("2026-08-09T12:00:00Z"),
    });

    for (const mode of ["recommended", "new", "nearby", "online", "verified"] as const) {
      const result = await repository.discover(viewerId, publicDiscoveryFilterSchema.parse({ mode }));
      expect(result.items.map((item) => item.id)).toContain(visible.profileId);
      expect(result.items.map((item) => item.id)).not.toContain(blocked.profileId);
      const item = result.items.find(({ id }) => id === visible.profileId)!;
      expect(item).toMatchObject({ displayName: "Visible", countryCode: "US" });
      expect(item).not.toHaveProperty("city");
      expect(item).not.toHaveProperty("birthDate");
      expect(item).not.toHaveProperty("score");
      expect(item).not.toHaveProperty("userId");
      expect(item.photos).toHaveLength(1);
      expect(result.rankingVersion).toBe("discovery-v1");
    }
  });

  it("applies disabled regions to the viewer and ignores expired verification", async () => {
    const expired = await addPerson({ email: "expired@example.test", displayName: "Expired verification" });
    await database.insert(schema.verificationAttempts).values({
      userId: expired.userId,
      kind: "identity",
      status: "approved",
      expiresAt: new Date("2026-08-08T11:59:59Z"),
    });
    const verified = await repository.discover(viewerId, publicDiscoveryFilterSchema.parse({ mode: "verified" }));
    expect(verified.items.map((item) => item.id)).not.toContain(expired.profileId);

    const disabledForViewer = new DiscoveryRepository(database, {
      clock: () => new Date("2026-08-08T12:00:00Z"),
      cursorSecret: CURSOR_SECRET,
      disabledCountryCodes: ["US"],
    });
    const result = await disabledForViewer.discover(viewerId, publicDiscoveryFilterSchema.parse({}));
    expect(result.items).toEqual([]);
  });

  it("uses signed stable keyset pagination without duplicates", async () => {
    const a = await addPerson({ email: "a@example.test", displayName: "A" });
    const b = await addPerson({
      email: "b@example.test", displayName: "B", createdAt: new Date("2026-08-08T01:00:00Z"),
    });
    await database.insert(schema.verificationAttempts).values({
      userId: a.userId, kind: "identity", status: "approved", expiresAt: new Date("2026-08-09T00:00:00Z"),
    });
    const filters = publicDiscoveryFilterSchema.parse({ pageSize: 1 });
    const first = await repository.discover(viewerId, filters);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.id).toBe(a.profileId);
    expect(first.nextCursor).toBeTruthy();
    await database.insert(schema.sessions).values({
      userId: b.userId,
      token: "became-online-after-snapshot",
      expiresAt: new Date("2026-08-09T00:00:00Z"),
      updatedAt: new Date("2026-08-08T12:30:00Z"),
    });
    await database.insert(schema.verificationAttempts).values({
      userId: b.userId,
      kind: "identity",
      status: "approved",
      expiresAt: new Date("2026-08-09T00:00:00Z"),
    });
    const newcomer = await addPerson({
      email: "new@example.test", displayName: "New", createdAt: new Date("2026-08-08T13:00:00Z"),
    });
    const second = await repository.discover(viewerId, { ...filters, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).toBe(b.profileId);
    expect(second.items[0]!.id).not.toBe(newcomer.profileId);
    await expect(repository.discover(viewerId, { ...filters, mode: "online", cursor: first.nextCursor ?? undefined }))
      .rejects.toThrow("INVALID_CURSOR");
  });

  it("binds snapshots to the owner and expiry", async () => {
    await addPerson({ email: "cursor-a@example.test", displayName: "Cursor A" });
    await addPerson({ email: "cursor-b@example.test", displayName: "Cursor B" });
    const filters = publicDiscoveryFilterSchema.parse({ pageSize: 1 });
    const first = await repository.discover(viewerId, filters);
    expect(first.nextCursor).toBeTruthy();
    const other = await addPerson({
      email: "cursor-owner2@example.test", displayName: "Cursor owner 2", genderCode: "man",
    });
    await expect(repository.discover(other.userId, { ...filters, cursor: first.nextCursor ?? undefined }))
      .rejects.toThrow("INVALID_CURSOR");
    now = new Date("2026-08-08T12:16:00Z");
    await expect(repository.discover(viewerId, { ...filters, cursor: first.nextCursor ?? undefined }))
      .rejects.toThrow("INVALID_CURSOR");
  });

  it("reuses equivalent snapshots and keeps at most three active snapshots per owner", async () => {
    await addPerson({ email: "bounded-a@example.test", displayName: "Bounded A" });
    await addPerson({ email: "bounded-b@example.test", displayName: "Bounded B" });
    const filters = publicDiscoveryFilterSchema.parse({ pageSize: 1 });
    await repository.discover(viewerId, filters);
    await repository.discover(viewerId, filters);
    expect(await database.select().from(schema.discoverySnapshots)
      .where(eq(schema.discoverySnapshots.ownerUserId, viewerId))).toHaveLength(1);
    const concurrent = await Promise.allSettled([19, 20, 21, 22, 23].map((minimumAge) =>
      repository.discover(viewerId, publicDiscoveryFilterSchema.parse({ minimumAge, pageSize: 1 }))));
    expect(concurrent.every((result) => result.status === "fulfilled"
      || (result.reason as Error).message === "DISCOVERY_SNAPSHOT_BUSY")).toBe(true);
    expect((await database.select().from(schema.discoverySnapshots)
      .where(eq(schema.discoverySnapshots.ownerUserId, viewerId))).length).toBeLessThanOrEqual(3);
  });

  it("caps evaluated candidates and marks a truncated snapshot", async () => {
    const olderEligible = await addPerson({
      email: "older-eligible@example.test",
      displayName: "Older eligible",
      createdAt: new Date("2026-08-08T01:00:00Z"),
    });
    const candidates = Array.from({ length: 201 }, (_, index) => ({
      userId: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
      index,
    }));
    await database.insert(schema.users).values(candidates.map(({ userId, index }) => ({
      id: userId, name: `Capped ${index}`, email: `capped-${index}@example.test`,
    })));
    await database.insert(schema.profiles).values(candidates.map(({ userId, profileId, index }) => ({
      id: profileId,
      userId,
      displayName: `Capped ${index}`,
      birthDate: "1992-01-01",
      genderCode: "woman",
      countryCode: "US",
      status: "active",
      discoverable: true,
      createdAt: new Date(new Date("2026-08-08T10:00:00Z").getTime() + index),
    })));
    await database.insert(schema.profilePreferences).values(candidates.map(({ userId }) => ({ userId })));
    await database.insert(schema.privacySettings).values(candidates.map(({ userId }) => ({ userId })));
    await database.insert(schema.profilePhotos).values(candidates.map(({ userId, profileId, index }) => ({
      userId,
      profileId,
      objectKey: `profile-review/${userId}/capped-${index}.jpg`,
      moderationStatus: "approved",
      position: 0,
    })));
    const result = await repository.discover(viewerId, publicDiscoveryFilterSchema.parse({ pageSize: 1 }));
    expect(result.snapshotTruncated).toBe(true);
    const [snapshot] = await database.select().from(schema.discoverySnapshots)
      .where(eq(schema.discoverySnapshots.ownerUserId, viewerId));
    expect(snapshot).toMatchObject({ truncated: true, itemCount: 100 });

    await database.update(schema.profilePreferences).set({ preferredCountryCodes: ["CA"] })
      .where(inArray(schema.profilePreferences.userId, candidates.map(({ userId }) => userId)));
    const afterHardFilter = await repository.discover(
      viewerId,
      publicDiscoveryFilterSchema.parse({ minimumAge: 19, pageSize: 1 }),
    );
    expect(afterHardFilter.items[0]!.id).toBe(olderEligible.profileId);
  });

  it("bounds unsafe-row scans and advances the continuation cursor", async () => {
    const hidden = Array.from({ length: 50 }, (_, index) => ({
      userId: crypto.randomUUID(), profileId: crypto.randomUUID(), index,
    }));
    await database.insert(schema.users).values(hidden.map(({ userId, index }) => ({
      id: userId, name: `Hidden ${index}`, email: `hidden-${index}@example.test`,
    })));
    await database.insert(schema.profiles).values(hidden.map(({ userId, profileId, index }) => ({
      id: profileId, userId, displayName: `Hidden ${index}`, birthDate: "1992-01-01",
      genderCode: "woman", countryCode: "US", status: "active", discoverable: false,
    })));
    await database.insert(schema.profilePreferences).values(hidden.map(({ userId }) => ({ userId })));
    await database.insert(schema.privacySettings).values(hidden.map(({ userId }) => ({ userId })));
    const fallback = await addPerson({ email: "scan-fallback@example.test", displayName: "Scan fallback" });
    const filters = publicDiscoveryFilterSchema.parse({ pageSize: 1 });
    const fingerprint = filterFingerprint(filters);
    const expiresAt = new Date("2026-08-08T12:15:00Z");
    const [snapshot] = await database.insert(schema.discoverySnapshots).values({
      ownerUserId: viewerId,
      mode: filters.mode,
      filterFingerprint: fingerprint,
      rankingVersion: RANKING_VERSION,
      status: "ready",
      itemCount: 51,
      truncated: false,
      expiresAt,
      createdAt: now,
    }).returning();
    await database.insert(schema.discoverySnapshotItems).values([
      ...hidden.map(({ userId, profileId }, ordinal) => ({
        snapshotId: snapshot.id, ordinal, candidateUserId: userId, candidateProfileId: profileId,
        score: 50, reasons: [],
      })),
      {
        snapshotId: snapshot.id, ordinal: 50, candidateUserId: fallback.userId,
        candidateProfileId: fallback.profileId, score: 50, reasons: [],
      },
    ]);
    const cursor = encodeDiscoveryCursor({
      rankingVersion: RANKING_VERSION,
      filterFingerprint: fingerprint,
      snapshotId: snapshot.id,
      nextOrdinal: 0,
      expiresAt: expiresAt.toISOString(),
    }, CURSOR_SECRET);
    const bounded = await repository.discover(viewerId, { ...filters, cursor });
    expect(bounded.items).toEqual([]);
    expect(bounded.nextCursor).toBeTruthy();
    expect(decodeDiscoveryCursor(bounded.nextCursor!, CURSOR_SECRET, {
      rankingVersion: RANKING_VERSION, filterFingerprint: fingerprint,
    }).nextOrdinal).toBe(50);
    const continued = await repository.discover(viewerId, { ...filters, cursor: bounded.nextCursor ?? undefined });
    expect(continued.items[0]!.id).toBe(fallback.profileId);
  });

  it("cleans up only the requested number of expired snapshots", async () => {
    await database.insert(schema.discoverySnapshots).values(Array.from({ length: 12 }, (_, index) => ({
      ownerUserId: viewerId,
      mode: "recommended",
      filterFingerprint: `expired-${index}`,
      rankingVersion: RANKING_VERSION,
      status: "ready",
      itemCount: 0,
      truncated: false,
      expiresAt: new Date("2026-08-08T11:00:00Z"),
      createdAt: new Date(`2026-08-08T${String(index).padStart(2, "0")}:00:00Z`),
    })));
    expect(await repository.cleanupExpiredSnapshots(5, now)).toBe(5);
    expect(await database.select().from(schema.discoverySnapshots)).toHaveLength(7);
  });

  it("rechecks preferences, blocks, and hidden state while continuing to fill the page", async () => {
    const firstCandidate = await addPerson({ email: "safe-a@example.test", displayName: "Safe A" });
    const incompatible = await addPerson({
      email: "incompatible-b@example.test", displayName: "Incompatible B",
      createdAt: new Date("2026-08-08T03:00:00Z"),
    });
    const unsafe = await addPerson({
      email: "unsafe-c@example.test", displayName: "Unsafe C", createdAt: new Date("2026-08-08T02:00:00Z"),
    });
    const fallback = await addPerson({
      email: "safe-d@example.test", displayName: "Safe D", createdAt: new Date("2026-08-08T01:00:00Z"),
    });
    await database.insert(schema.verificationAttempts).values({
      userId: firstCandidate.userId,
      kind: "identity",
      status: "approved",
      expiresAt: new Date("2026-08-09T00:00:00Z"),
    });
    const filters = publicDiscoveryFilterSchema.parse({ pageSize: 1 });
    const first = await repository.discover(viewerId, filters);
    expect(first.items[0]!.id).toBe(firstCandidate.profileId);
    await database.update(schema.profilePreferences).set({ genderCodes: ["woman"] })
      .where(eq(schema.profilePreferences.userId, incompatible.userId));
    await database.insert(schema.userBlocks).values({ blockerUserId: viewerId, blockedUserId: unsafe.userId });
    await database.update(schema.profiles).set({ discoverable: false }).where(eq(schema.profiles.id, unsafe.profileId));
    const second = await repository.discover(viewerId, { ...filters, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).toBe(fallback.profileId);
  });

  it("rechecks online and verified mode eligibility on later pages", async () => {
    const onlineProfiles = await Promise.all([
      addPerson({ email: "online-a@example.test", displayName: "Online A", createdAt: new Date("2026-08-08T03:00:00Z") }),
      addPerson({ email: "online-b@example.test", displayName: "Online B", createdAt: new Date("2026-08-08T02:00:00Z") }),
      addPerson({ email: "online-c@example.test", displayName: "Online C", createdAt: new Date("2026-08-08T01:00:00Z") }),
    ]);
    await database.insert(schema.sessions).values(onlineProfiles.map((profile, index) => ({
      userId: profile.userId,
      token: `online-mode-${index}`,
      expiresAt: new Date("2026-08-09T00:00:00Z"),
      updatedAt: new Date("2026-08-08T11:55:00Z"),
    })));
    const onlineFilters = publicDiscoveryFilterSchema.parse({ mode: "online", pageSize: 1 });
    const onlineFirst = await repository.discover(viewerId, onlineFilters);
    expect(onlineFirst.items[0]!.id).toBe(onlineProfiles[0]!.profileId);
    await database.update(schema.sessions).set({ expiresAt: new Date("2026-08-08T11:59:00Z") })
      .where(eq(schema.sessions.userId, onlineProfiles[1]!.userId));
    const onlineSecond = await repository.discover(viewerId, {
      ...onlineFilters, cursor: onlineFirst.nextCursor ?? undefined,
    });
    expect(onlineSecond.items[0]!.id).toBe(onlineProfiles[2]!.profileId);

    const verifiedProfiles = await Promise.all([
      addPerson({ email: "verified-a@example.test", displayName: "Verified A", createdAt: new Date("2026-08-08T06:00:00Z") }),
      addPerson({ email: "verified-b@example.test", displayName: "Verified B", createdAt: new Date("2026-08-08T05:00:00Z") }),
      addPerson({ email: "verified-c@example.test", displayName: "Verified C", createdAt: new Date("2026-08-08T04:00:00Z") }),
    ]);
    await database.insert(schema.verificationAttempts).values(verifiedProfiles.map((profile) => ({
      userId: profile.userId,
      kind: "identity",
      status: "approved",
      expiresAt: new Date("2026-08-09T00:00:00Z"),
    })));
    const verifiedFilters = publicDiscoveryFilterSchema.parse({ mode: "verified", pageSize: 1 });
    const verifiedFirst = await repository.discover(viewerId, verifiedFilters);
    expect(verifiedFirst.items[0]!.id).toBe(verifiedProfiles[0]!.profileId);
    await database.update(schema.verificationAttempts).set({ expiresAt: new Date("2026-08-08T11:59:00Z") })
      .where(eq(schema.verificationAttempts.userId, verifiedProfiles[1]!.userId));
    const verifiedSecond = await repository.discover(viewerId, {
      ...verifiedFilters, cursor: verifiedFirst.nextCursor ?? undefined,
    });
    expect(verifiedSecond.items[0]!.id).toBe(verifiedProfiles[2]!.profileId);
  });

  it("enforces owner-scoped saved searches and the 20-search limit", async () => {
    const created = await repository.createSavedSearch(viewerId, "My search", { mode: "nearby", minimumAge: 25 });
    expect(created.filters).toMatchObject({ mode: "nearby", minimumAge: 25 });
    expect(await repository.renameSavedSearch(viewerId, created.id, "Renamed")).toMatchObject({ name: "Renamed" });
    const other = await addPerson({ email: "owner2@example.test", displayName: "Owner 2" });
    await expect(repository.renameSavedSearch(other.userId, created.id, "Stolen")).resolves.toBeNull();
    for (let index = 1; index < 20; index += 1) {
      await repository.createSavedSearch(viewerId, `Search ${index}`, { mode: "recommended" });
    }
    await expect(repository.createSavedSearch(viewerId, "Overflow", { mode: "recommended" }))
      .rejects.toThrow("SAVED_SEARCH_LIMIT");
    expect(await repository.deleteSavedSearch(other.userId, created.id)).toBe(false);
    expect(await repository.deleteSavedSearch(viewerId, created.id)).toBe(true);
  });
});
