import { describe, expect, it } from "vitest";

import { isCandidateEligible } from "@/modules/discovery/candidate-policy";
import { rankCandidate } from "@/modules/discovery/ranking";

const person = (overrides: Record<string, unknown> = {}) => ({
  userId: crypto.randomUUID(),
  birthDate: "1990-01-01",
  genderCode: "woman",
  countryCode: "US",
  status: "active",
  discoverable: true,
  approvedPhotoCount: 1,
  preferences: { minimumAge: 18, maximumAge: 100, genderCodes: [] },
  ...overrides,
});

describe("rankCandidate", () => {
  it("never scores an ineligible candidate", () => {
    expect(rankCandidate({
      eligible: false,
      compatibilityScore: 50,
      activityScore: 10,
      verificationScore: 10,
      boost: 99,
    })).toBeNull();
  });

  it("caps paid boost and adds it only after eligibility", () => {
    expect(rankCandidate({
      eligible: true,
      compatibilityScore: 50,
      activityScore: 10,
      verificationScore: 10,
      boost: 3,
    })).toBe(85);
    expect(rankCandidate({
      eligible: true,
      compatibilityScore: 50,
      activityScore: 10,
      verificationScore: 10,
      boost: -2,
    })).toBe(70);
  });

  it.each([
    ["compatibility score", { compatibilityScore: Number.NaN }],
    ["activity score", { activityScore: Number.POSITIVE_INFINITY }],
    ["verification score", { verificationScore: Number.NEGATIVE_INFINITY }],
    ["boost", { boost: Number.NaN }],
  ])("rejects a non-finite %s", (_label, override) => {
    expect(rankCandidate({
      eligible: true,
      compatibilityScore: 50,
      activityScore: 10,
      verificationScore: 10,
      boost: 1,
      ...override,
    })).toBeNull();
  });
});

describe("candidate hard-filter policy", () => {
  const exclusions: Array<[string, {
    sameUser?: boolean;
    viewerBlockedCandidate?: boolean;
    candidateBlockedViewer?: boolean;
    disabledRegion?: boolean;
    candidate?: Record<string, unknown>;
  }]> = [
    ["self", { sameUser: true }],
    ["viewer blocked candidate", { viewerBlockedCandidate: true }],
    ["candidate blocked viewer", { candidateBlockedViewer: true }],
    ["restricted", { candidate: { status: "restricted" } }],
    ["not discoverable", { candidate: { discoverable: false } }],
    ["no approved photo", { candidate: { approvedPhotoCount: 0 } }],
    ["disabled region", { disabledRegion: true }],
  ];
  it.each(exclusions)("rejects %s before ranking", (_label, change) => {
    const viewer = person();
    const candidate = person({
      userId: change.sameUser ? viewer.userId : crypto.randomUUID(),
      ...(change.candidate ?? {}),
    });
    expect(isCandidateEligible({
      viewer,
      candidate,
      viewerBlockedCandidate: Boolean(change.viewerBlockedCandidate),
      candidateBlockedViewer: Boolean(change.candidateBlockedViewer),
      disabledRegion: Boolean(change.disabledRegion),
      now: new Date("2026-08-08T00:00:00Z"),
    })).toBe(false);
  });

  it("requires age and gender preference compatibility in both directions", () => {
    const viewer = person({
      birthDate: "1990-01-01",
      genderCode: "woman",
      preferences: { minimumAge: 30, maximumAge: 40, genderCodes: ["man"] },
    });
    const compatible = person({
      birthDate: "1992-01-01",
      genderCode: "man",
      preferences: { minimumAge: 30, maximumAge: 40, genderCodes: ["woman"] },
    });
    expect(isCandidateEligible({ viewer, candidate: compatible, now: new Date("2026-08-08T00:00:00Z") }))
      .toBe(true);
    expect(isCandidateEligible({
      viewer,
      candidate: { ...compatible, preferences: { ...compatible.preferences, genderCodes: ["man"] } },
      now: new Date("2026-08-08T00:00:00Z"),
    })).toBe(false);
    expect(isCandidateEligible({
      viewer,
      candidate: { ...compatible, birthDate: "2000-01-01" },
      now: new Date("2026-08-08T00:00:00Z"),
    })).toBe(false);
  });

  it("requires country preference compatibility in both directions", () => {
    const viewer = person({
      countryCode: "US",
      preferences: { minimumAge: 18, maximumAge: 100, genderCodes: [], preferredCountryCodes: ["CA"] },
    });
    const candidate = person({
      countryCode: "US",
      preferences: { minimumAge: 18, maximumAge: 100, genderCodes: [], preferredCountryCodes: [] },
    });
    expect(isCandidateEligible({ viewer, candidate, now: new Date("2026-08-08T00:00:00Z") })).toBe(false);
    expect(isCandidateEligible({
      viewer: { ...viewer, preferences: { ...viewer.preferences, preferredCountryCodes: [] } },
      candidate: { ...candidate, preferences: { ...candidate.preferences, preferredCountryCodes: ["CA"] } },
      now: new Date("2026-08-08T00:00:00Z"),
    })).toBe(false);
  });
});
