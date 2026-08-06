import { describe, expect, it } from "vitest";

import {
  assertAdult,
  calculateProfileCompleteness,
  publicProfile,
  profileVisibility,
} from "@/modules/profiles/profile-service";
import { profilePatchSchema } from "@/modules/profiles/profile-schema";

describe("profile rules", () => {
  it("rejects a user younger than 18", () => {
    expect(() => assertAdult("2010-08-05", new Date("2026-08-05T12:00:00Z"))).toThrow(
      "AGE_RESTRICTED",
    );
  });

  it("never returns precise coordinates", () => {
    const result = publicProfile({
      id: "p1",
      city: "Seattle",
      latitude: 47.61,
      longitude: -122.33,
    });
    expect(result).toEqual({ id: "p1", city: "Seattle" });
  });

  it.each([
    ["2008-08-05", true],
    ["2008-08-04", true],
    ["2008-08-06", false],
  ])("applies the exact eighteenth birthday boundary for %s", (birthDate, allowed) => {
    const call = () => assertAdult(birthDate, new Date("2026-08-05T23:59:59Z"));
    if (allowed) expect(call).not.toThrow();
    else expect(call).toThrow("AGE_RESTRICTED");
  });

  it("treats a leap-day birthday as reached on February 28 in a non-leap year", () => {
    expect(() => assertAdult("2008-02-29", new Date("2026-02-28T00:00:00Z"))).not.toThrow();
    expect(() => assertAdult("2008-02-29", new Date("2026-02-27T23:59:59Z"))).toThrow(
      "AGE_RESTRICTED",
    );
  });

  it.each(["2008-2-05", "2008-02-30", "2008-02-05T00:00:00Z"])(
    "rejects non-date-only or impossible date %s",
    (birthDate) => {
      expect(() => assertAdult(birthDate, new Date("2026-08-05T12:00:00Z"))).toThrow(
        "INVALID_BIRTH_DATE",
      );
    },
  );

  it("uses a real ISO country allowlist and inclusive extensible codes", () => {
    expect(profilePatchSchema.safeParse({
      displayName: "Ari",
      birthDate: "1990-01-01",
      genderCode: "nonbinary_agender",
      relationshipGoalCode: "ethical_non_monogamy",
      countryCode: "US",
      city: "Seattle",
      preferences: {
        genderCodes: ["woman", "nonbinary_agender", "self_described"],
        preferredCountryCodes: ["CN", "US"],
        minimumAge: 18,
        maximumAge: 99,
        languageCodes: ["en", "zh-Hans"],
        relationshipGoalCodes: ["long_term", "ethical_non_monogamy"],
      },
      privacy: { locationPrecision: "city" },
    }).success).toBe(true);
    expect(profilePatchSchema.safeParse({ countryCode: "ZZ" }).success).toBe(false);
  });

  it("only returns explicitly approved public fields", () => {
    const result = publicProfile({
      id: "p1",
      displayName: "Ari",
      city: "Seattle",
      countryCode: "US",
      age: 31,
      latitude: 47.61,
      longitude: -122.33,
      birthDate: "1995-01-01",
      email: "private@example.test",
      phone: "+14155550123",
      statusReason: "internal",
      risk: "high",
      providerReference: "provider-secret",
      privacy: { showOnlineStatus: false },
    });
    expect(result).toEqual({
      id: "p1",
      displayName: "Ari",
      city: "Seattle",
      countryCode: "US",
      age: 31,
    });
  });

  it("deep-whitelists public photo fields instead of exposing storage or review metadata", () => {
    expect(publicProfile({
      id: "p1",
      photos: [{
        id: "photo-1",
        url: "https://cdn.example.test/public/photo-1",
        width: 800,
        height: 600,
        moderationStatus: "approved",
        objectKey: "profile-media/private/object.png",
        moderationReasonCode: "internal-reason",
        reviewProvider: "vendor",
      }, {
        id: "photo-pending",
        url: "https://cdn.example.test/private/photo-pending",
        moderationStatus: "pending",
      }],
    })).toEqual({
      id: "p1",
      photos: [{ id: "photo-1", url: "https://cdn.example.test/public/photo-1", width: 800, height: 600 }],
    });
  });

  it("calculates completeness deterministically", () => {
    expect(calculateProfileCompleteness({ displayName: "Ari" })).toEqual({
      completed: 1,
      total: 8,
      percent: 13,
    });
    expect(calculateProfileCompleteness({
      displayName: "Ari",
      birthDate: "1990-01-01",
      genderCode: "nonbinary",
      countryCode: "US",
      city: "Seattle",
      bio: "Hello",
      languageCodes: ["en"],
      interestCodes: ["hiking"],
    })).toEqual({ completed: 8, total: 8, percent: 100 });
  });

  it("fails profile visibility closed for account state, profile state, and photo approval", () => {
    expect(profileVisibility({ accountStatus: "active", profileStatus: "active", discoverable: true, approvedPhotoCount: 1 })).toBe(true);
    expect(profileVisibility({ accountStatus: "active", profileStatus: "active", discoverable: true, approvedPhotoCount: 0 })).toBe(false);
    expect(profileVisibility({ accountStatus: "suspended", profileStatus: "active", discoverable: true, approvedPhotoCount: 1 })).toBe(false);
    expect(profileVisibility({ accountStatus: "active", profileStatus: "draft", discoverable: true, approvedPhotoCount: 1 })).toBe(false);
  });
});
