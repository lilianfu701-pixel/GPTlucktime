import { describe, expect, it } from "vitest";

import { resolveCivilTime } from "./civil-time";

describe("resolveCivilTime", () => {
  it("rejects a local time skipped by a DST spring-forward transition", () => {
    const result = resolveCivilTime(
      "2024-03-10T02:30:00",
      "America/New_York",
    );

    expect(result).toMatchObject({ ok: false, code: "DST_GAP" });
  });

  it("requires a resolution for a DST fall-back overlap", () => {
    const result = resolveCivilTime(
      "2024-11-03T01:30:00",
      "America/New_York",
    );

    expect(result).toMatchObject({ ok: false, code: "DST_AMBIGUOUS" });
  });

  it("rejects an invalid runtime DST resolution", () => {
    const resolution = "invalid" as never;
    const result = resolveCivilTime(
      "2024-11-03T01:30:00",
      "America/New_York",
      resolution,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_CIVIL_TIME_RESOLUTION",
    });
  });

  it("resolves both occurrences of a DST overlap to different instants", () => {
    const earlier = resolveCivilTime(
      "2024-11-03T01:30:00",
      "America/New_York",
      "earlier",
    );
    const later = resolveCivilTime(
      "2024-11-03T01:30:00",
      "America/New_York",
      "later",
    );

    expect(earlier).toMatchObject({ ok: true });
    expect(later).toMatchObject({ ok: true });
    if (earlier.ok && later.ok) {
      expect(earlier.value.resolution).toBe("earlier");
      expect(later.value.resolution).toBe("later");
      expect(earlier.value.utcIso).not.toBe(later.value.utcIso);
      expect(earlier.value.offsetMinutes).toBe(-240);
      expect(earlier.value.standardMeridianLongitude).toBe(-75);
      expect(earlier.value.dstOffsetMinutes).toBe(60);
      expect(Object.isFrozen(earlier.value)).toBe(true);
    }
  });

  it("returns offset and standard-meridian details for an ordinary IANA time", () => {
    const result = resolveCivilTime(
      "2024-06-15T14:30:00",
      "Asia/Shanghai",
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value).toMatchObject({
        utcIso: "2024-06-15T06:30:00.000Z",
        offsetMinutes: 480,
        dstOffsetMinutes: 0,
        standardMeridianLongitude: 120,
        resolution: null,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("returns a structured error for an invalid time zone without throwing", () => {
    expect(() =>
      resolveCivilTime("2024-06-15T14:30:00", "Mars/Olympus"),
    ).not.toThrow();

    const result = resolveCivilTime(
      "2024-06-15T14:30:00",
      "Mars/Olympus",
    );

    expect(result).toMatchObject({ ok: false, code: "INVALID_TIME_ZONE" });
  });
});
