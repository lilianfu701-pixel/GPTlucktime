import { cookies } from "next/headers";
import { correlationIdFrom, jsonSuccess } from "@/lib/api";
import { clearSessionCookie } from "@/modules/auth/cookies";
import { SESSION_COOKIE_NAME, resolveSession, revokeSession } from "@/modules/auth/sessions";

export const dynamic = "force-dynamic";

/**
 * Signs out.
 *
 * The session row is revoked as well as the cookie cleared. Clearing only the
 * cookie would leave a live token behind, and someone signing out on a shared
 * or borrowed device is doing it precisely because they do not trust what
 * happens to that machine next.
 *
 * Always answers 200. A caller with no session, or an expired one, wanted to
 * end up signed out and now is; reporting an error would only invite a client
 * to retry something that already achieved what was asked.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    const session = await resolveSession({ token });
    if (session.ok) {
      await revokeSession({ sessionId: session.value.sessionId });
    }
  }

  return clearSessionCookie(jsonSuccess({ signedOut: true }, correlationId));
}
