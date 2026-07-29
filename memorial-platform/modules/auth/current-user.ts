import { cookies } from "next/headers";
import type { Actor } from "@/modules/permissions/types";
import { ANONYMOUS_ACTOR } from "@/modules/permissions/types";
import { SESSION_COOKIE_NAME } from "./sessions";
import { resolveSession } from "./sessions";

/**
 * Resolves the caller from the session cookie.
 *
 * Returns the anonymous actor rather than throwing when there is no valid
 * session: whether that is acceptable is the permission layer's decision, not
 * this function's.
 *
 * `platformRole` is not yet stored, so everyone is an ordinary user. Staff roles
 * arrive with the administration work in a later task; until then no request can
 * obtain governance powers, which is the safe direction to be wrong in.
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

  return { userId: session.value.userId, platformRole: "user" };
}
