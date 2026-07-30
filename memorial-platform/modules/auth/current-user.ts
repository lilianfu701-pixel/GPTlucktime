import { cookies } from "next/headers";
import type { Actor } from "@/modules/permissions/types";
import { ANONYMOUS_ACTOR } from "@/modules/permissions/types";
import { SESSION_COOKIE_NAME, resolveSession } from "./sessions";

/**
 * Resolves the caller from the session cookie.
 *
 * Returns the anonymous actor rather than throwing when there is no valid
 * session: whether that is acceptable is the permission layer's decision, not
 * this function's.
 *
 * `platformRole` comes from the account row. No route grants it — raising
 * someone to reviewer or super admin is a deliberate database action — so there
 * is no request that can talk its way into staff powers.
 */
export async function currentActor(): Promise<Actor> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return ANONYMOUS_ACTOR;
  }

  const session = await resolveSession({ token });
  if (!session.ok) {
    return ANONYMOUS_ACTOR;
  }

  return {
    userId: session.value.userId,
    platformRole: session.value.platformRole,
  };
}
