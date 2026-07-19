import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CHART_PAYLOAD_LENGTH,
  decodeChartPayload,
  encodeChartPayload,
} from "./chart-payload";

const input = {
  localDateTime: "1990-06-15T14:30:45",
  timeZone: "Asia/Shanghai",
  birthplace: {
    name: "上海市徐汇区",
    latitude: 31.1802,
    longitude: 121.4375,
  },
  timePrecision: "approximate" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("chart payload", () => {
  it("round-trips a versioned UTF-8 birth input as base64url", () => {
    const payload = encodeChartPayload(input);

    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).not.toMatch(/[+/=]/);
    expect(decodeChartPayload(payload)).toEqual(input);
  });

  it("does not require a browser Buffer polyfill", () => {
    vi.stubGlobal("Buffer", undefined);

    expect(decodeChartPayload(encodeChartPayload(input))).toEqual(input);
  });

  it.each(["", "%%%", "a", "eyJ2ZXJzaW9uIjoyfQ"])(
    "rejects malformed or unsupported payload %s",
    (payload) => {
      expect(decodeChartPayload(payload)).toBeNull();
    },
  );

  it("rejects an oversized payload before decoding", () => {
    expect(decodeChartPayload("a".repeat(MAX_CHART_PAYLOAD_LENGTH + 1))).toBeNull();
  });
});
