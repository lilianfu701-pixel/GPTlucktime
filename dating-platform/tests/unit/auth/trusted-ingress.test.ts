import { describe, expect, it } from "vitest";

import { resolveTrustedClientBucket } from "@/modules/auth/trusted-ingress";

const token = "trusted-ingress-token-at-least-32-characters";

const request = (headers: Record<string, string>) => new Request("https://app.test/auth", { headers });

describe("trusted ingress client bucket", () => {
  it("ignores spoofed forwarding headers without a trusted ingress token", () => {
    expect(resolveTrustedClientBucket(request({ "x-forwarded-for": "203.0.113.1" }), token))
      .toBe("untrusted-network");
    expect(resolveTrustedClientBucket(request({ "x-forwarded-for": "203.0.113.2" }), token))
      .toBe("untrusted-network");
  });

  it("accepts one normalized client IP only from the trusted ingress", () => {
    expect(resolveTrustedClientBucket(request({
      "x-auth-ingress-token": token,
      "x-auth-client-ip": "2001:db8::1",
      "x-forwarded-for": "198.51.100.2, 198.51.100.3",
    }), token)).toBe("2001:db8::1");
  });

  it.each(["198.51.100.1, 198.51.100.2", "unknown", "198.51.100.1:443"])(
    "rejects ambiguous or non-normalized trusted client IP %s",
    (clientIp) => expect(resolveTrustedClientBucket(request({
      "x-auth-ingress-token": token,
      "x-auth-client-ip": clientIp,
    }), token)).toBe("untrusted-network"),
  );
});
