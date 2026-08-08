import { describe, expect, it } from "vitest";

import { publicDiscoveryFilterSchema } from "@/modules/discovery/discovery-types";
import { decodeDiscoveryCursor, encodeDiscoveryCursor, filterFingerprint } from "@/modules/discovery/ranking";

describe("discovery public input", () => {
  it("uses one strict bounded schema for all modes", () => {
    for (const mode of ["recommended", "new", "nearby", "online", "verified"]) {
      expect(publicDiscoveryFilterSchema.parse({ mode })).toMatchObject({ mode });
    }
    expect(publicDiscoveryFilterSchema.safeParse({ mode: "recommended", latitude: 1, longitude: 2 }).success)
      .toBe(false);
    expect(publicDiscoveryFilterSchema.safeParse({ mode: "recommended", pageSize: 51 }).success).toBe(false);
    expect(publicDiscoveryFilterSchema.safeParse({ mode: "recommended", genderCodes: Array(31).fill("woman") }).success)
      .toBe(false);
  });

  it("signs opaque cursors and binds them to version and filter fingerprint", () => {
    const filters = publicDiscoveryFilterSchema.parse({ mode: "nearby", minimumAge: 25 });
    const fingerprint = filterFingerprint(filters);
    const cursor = encodeDiscoveryCursor({
      rankingVersion: "discovery-v1",
      filterFingerprint: fingerprint,
      snapshotId: crypto.randomUUID(),
      nextOrdinal: 20,
      expiresAt: "2026-08-08T00:15:00.000Z",
    }, "x".repeat(32));
    expect(cursor).not.toContain("snapshotId");
    expect(decodeDiscoveryCursor(cursor, "x".repeat(32), {
      rankingVersion: "discovery-v1",
      filterFingerprint: fingerprint,
    })).toMatchObject({ nextOrdinal: 20, expiresAt: "2026-08-08T00:15:00.000Z" });
    expect(() => decodeDiscoveryCursor(`${cursor}x`, "x".repeat(32), {
      rankingVersion: "discovery-v1",
      filterFingerprint: fingerprint,
    })).toThrow("INVALID_CURSOR");
    expect(() => decodeDiscoveryCursor(cursor, "x".repeat(32), {
      rankingVersion: "discovery-v1",
      filterFingerprint: filterFingerprint({ ...filters, mode: "online" }),
    })).toThrow("INVALID_CURSOR");
  });
});
