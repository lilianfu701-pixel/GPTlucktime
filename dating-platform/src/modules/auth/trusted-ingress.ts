import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const INGRESS_TOKEN_HEADER = "x-auth-ingress-token";
const CLIENT_IP_HEADER = "x-auth-client-ip";

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * The ingress must strip both internal headers from public requests, then set
 * exactly one normalized IP and the shared token on the server-to-server hop.
 */
export function resolveTrustedClientBucket(
  request: Request,
  trustedProxyToken: string | undefined,
): string {
  if (!trustedProxyToken) return "untrusted-network";
  const suppliedToken = request.headers.get(INGRESS_TOKEN_HEADER) ?? "";
  if (!constantTimeEqual(suppliedToken, trustedProxyToken)) return "untrusted-network";
  const clientIp = request.headers.get(CLIENT_IP_HEADER) ?? "";
  if (clientIp !== clientIp.trim() || clientIp.includes(",") || isIP(clientIp) === 0) {
    return "untrusted-network";
  }
  return clientIp;
}
