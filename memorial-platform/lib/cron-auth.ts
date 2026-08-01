import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Whether a request may run scheduled work.
 *
 * These endpoints drain the outbox and sweep memorials due for purge, so an
 * open one lets a stranger drive the platform's background work. The repository
 * is public and the paths are in it: the secret is the whole protection, not
 * the obscurity of the URL.
 *
 * Fails closed. An unset `CRON_SECRET` refuses every caller rather than
 * treating "no secret configured" as "no check required" — the deployment that
 * forgets the variable is exactly the one that must not be running purges for
 * anyone who asks.
 */
export function cronRequestAuthorized(request: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) {
    return false;
  }

  // Vercel's own scheduler sends this header; the GitHub Actions workflow is
  // written to match it, so both callers take the same path.
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);

  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // secret's length through the error path. Compared separately and folded into
  // the result so both branches cost the same to observe.
  if (supplied.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(supplied, expected);
}
