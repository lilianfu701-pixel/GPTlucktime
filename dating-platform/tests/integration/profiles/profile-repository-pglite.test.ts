// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { createProfileHandler } from "@/modules/profiles/profile-service";
import { ProfileRepository } from "@/modules/profiles/profile-repository";

describe("profile repository and handler", () => {
  let client: PGlite;
  let repository: ProfileRepository;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle" });
    repository = new ProfileRepository(database);
    [{ id: userId }] = await database.insert(schema.users).values({
      name: "Profile Owner",
      email: "profile-owner@example.test",
    }).returning({ id: schema.users.id });
  });

  afterEach(async () => client.close());

  it("atomically upserts profile, preferences, privacy, and interests for retry safety", async () => {
    const input = {
      displayName: "Ari",
      birthDate: "1990-01-01",
      genderCode: "nonbinary",
      relationshipGoalCode: "long_term",
      countryCode: "US",
      city: "Seattle",
      bio: "Hello",
      languageCodes: ["en", "zh-Hans"],
      interestCodes: ["hiking", "books"],
      discoverable: true,
      preferences: {
        genderCodes: ["woman", "nonbinary"],
        minimumAge: 24,
        maximumAge: 42,
        preferredCountryCodes: ["US", "CA"],
        languageCodes: ["en", "zh-Hans"],
        relationshipGoalCodes: ["long_term"],
      },
      privacy: {
        showOnlineStatus: false,
        showLastActive: false,
        showProfileVisitors: true,
        locationPrecision: "city" as const,
      },
    };
    const first = await repository.upsertForUser(userId, input);
    const second = await repository.upsertForUser(userId, input);
    expect(second.id).toBe(first.id);
    expect(second.preferences).toMatchObject({ minimumAge: 24, maximumAge: 42 });
    expect(second.privacy).toMatchObject({ showOnlineStatus: false, locationPrecision: "city" });
    expect(second.interestCodes).toEqual(["books", "hiking"]);
    expect(second.languageCodes).toEqual(["en", "zh-Hans"]);
    expect(await repository.getForUser(userId)).toEqual(second);
  });

  it("uses only the authenticated owner and rejects an incomplete first write", async () => {
    await expect(repository.upsertForUser(userId, { city: "Portland" })).rejects.toThrow(
      "PROFILE_INCOMPLETE",
    );
    expect(await repository.getForUser(userId)).toBeNull();

    const [{ id: otherId }] = await repository.database.insert(schema.users).values({
      name: "Other",
      email: "other-profile@example.test",
    }).returning({ id: schema.users.id });
    expect(await repository.getForUser(otherId)).toBeNull();
  });

  it("returns stable unauthorized and validation errors without internal details", async () => {
    const unauthorized = createProfileHandler({
      getSession: async () => null,
      repository,
      clock: () => new Date("2026-08-05T12:00:00Z"),
    });
    const response = await unauthorized(new Request("http://localhost/api/v1/me/profile"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" });

    const authenticated = createProfileHandler({
      getSession: async () => ({ user: { id: userId } }),
      repository,
      clock: () => new Date("2026-08-05T12:00:00Z"),
    });
    const invalid = await authenticated(new Request("http://localhost/api/v1/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: crypto.randomUUID(), status: "active", risk: "low" }),
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ code: "INVALID_PROFILE", message: "INVALID_PROFILE" });
  });
});
