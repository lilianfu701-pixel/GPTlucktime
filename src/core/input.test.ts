import { describe, expect, it } from "vitest";

import { normalizeBirthInput } from "./input";

const valid = {
  localDateTime: "1990-06-15T14:30:00",
  timeZone: "Asia/Shanghai",
  birthplace: {
    name: "Shanghai",
    latitude: 31.2304,
    longitude: 121.4737,
  },
  timePrecision: "exact" as const,
};

describe("normalizeBirthInput", () => {
  it("returns an immutable normalized input", () => {
    const result = normalizeBirthInput(valid);

    expect(result).toMatchObject({ ok: true });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) {
      expect(result.value.birthplace.longitude).toBe(121.4737);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.birthplace)).toBe(true);
    }
  });

  it("trims names and preserves residence context without using it for calculation", () => {
    const residenceContext = {
      name: "  Los Angeles  ",
      latitude: 34.0522,
      longitude: -118.2437,
      timeZone: "America/Los_Angeles",
    };
    const result = normalizeBirthInput({
      ...valid,
      birthplace: { ...valid.birthplace, name: "  Shanghai  " },
      residenceContext,
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.birthplace.name).toBe("Shanghai");
      expect(result.value.residenceContext).toEqual({
        ...residenceContext,
        name: "Los Angeles",
      });
      expect(Object.isFrozen(result.value.residenceContext)).toBe(true);
    }
  });

  it("rejects a latitude outside the Earth range", () => {
    const result = normalizeBirthInput({
      ...valid,
      birthplace: { ...valid.birthplace, latitude: 91 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_COORDINATES" });
  });

  it("rejects a longitude outside the Earth range", () => {
    const result = normalizeBirthInput({
      ...valid,
      birthplace: { ...valid.birthplace, longitude: -181 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_COORDINATES" });
  });

  it("rejects an invalid IANA time zone", () => {
    const result = normalizeBirthInput({ ...valid, timeZone: "Mars/Olympus" });

    expect(result).toMatchObject({ ok: false, code: "INVALID_TIME_ZONE" });
  });

  it("rejects local datetimes with a UTC offset", () => {
    const result = normalizeBirthInput({
      ...valid,
      localDateTime: "1990-06-15T14:30:00+08:00",
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("rejects an empty birthplace name", () => {
    const result = normalizeBirthInput({
      ...valid,
      birthplace: { ...valid.birthplace, name: "   " },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
