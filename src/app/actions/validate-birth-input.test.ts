import { describe, expect, it, vi } from "vitest";

import { validateBirthInputAction } from "./validate-birth-input";

const shanghai = {
  localDateTime: "1990-06-15T14:30:00",
  timeZone: "Asia/Shanghai",
  birthplace: { name: " 上海 ", latitude: 31.2304, longitude: 121.4737 },
  timePrecision: "exact" as const,
};

const newYork = {
  timeZone: "America/New_York",
  birthplace: { name: "纽约", latitude: 40.7128, longitude: -74.006 },
  timePrecision: "exact" as const,
};

describe("validateBirthInputAction", () => {
  it("returns a normalized Shanghai input after authoritative civil-time validation", async () => {
    await expect(validateBirthInputAction(shanghai)).resolves.toMatchObject({
      valid: true,
      normalized: {
        localDateTime: "1990-06-15T14:30:00",
        timeZone: "Asia/Shanghai",
        birthplace: { name: "上海" },
      },
    });
  });

  it("maps a New York DST gap to the birth date and time fields", async () => {
    await expect(
      validateBirthInputAction({
        ...newYork,
        localDateTime: "2024-03-10T02:30:00",
      }),
    ).resolves.toMatchObject({
      valid: false,
      code: "DST_GAP",
      fieldErrors: {
        birthDate: expect.stringMatching(/夏令时/),
        birthTime: expect.stringMatching(/夏令时/),
      },
    });
  });

  it("requires a resolution for a New York DST overlap and accepts later", async () => {
    const overlap = {
      ...newYork,
      localDateTime: "2024-11-03T01:30:00",
    };

    await expect(validateBirthInputAction(overlap)).resolves.toMatchObject({
      valid: false,
      code: "DST_AMBIGUOUS",
      fieldErrors: {
        civilTimeResolution: expect.stringMatching(/较早或较晚/),
      },
    });
    await expect(
      validateBirthInputAction({ ...overlap, civilTimeResolution: "later" }),
    ).resolves.toMatchObject({
      valid: true,
      normalized: { civilTimeResolution: "later" },
    });
  });

  it("keeps an invalid IANA zone on the time-zone field without logging", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    await expect(
      validateBirthInputAction({ ...shanghai, timeZone: "Mars/Olympus" }),
    ).resolves.toMatchObject({
      valid: false,
      code: "INVALID_TIME_ZONE",
      fieldErrors: { timeZone: expect.stringMatching(/IANA/) },
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
