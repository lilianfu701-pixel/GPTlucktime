import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { emailCredentials, users } from "@/db/schema";
import type { Actor } from "@/modules/permissions/types";

/** The dedicated account that owns imported seed pages. */
const STEWARD_EMAIL = "genealogy-import@missingu.org";

/**
 * The steward actor an import runs as.
 *
 * A single account owns every seeded page, rather than whichever admin ran the
 * import — so ownership is stable, the seeded 族谱 is not tied to one person's
 * account, and the graph links between seeds confirm at once (one steward speaks
 * for both ends). Created on first use, reused thereafter.
 */
export async function ensureImportStewardActor(): Promise<Actor> {
  const existing = await db()
    .select({ userId: emailCredentials.userId })
    .from(emailCredentials)
    .where(eq(emailCredentials.email, STEWARD_EMAIL))
    .limit(1);

  let userId = existing[0]?.userId;
  if (!userId) {
    const [user] = await db()
      .insert(users)
      .values({
        displayName: "族谱导入管理员",
        fullName: "族谱导入管理员",
        preferredLocale: "zh-CN",
      })
      .returning({ id: users.id });
    await db().insert(emailCredentials).values({
      userId: user!.id,
      email: STEWARD_EMAIL,
      verifiedAt: new Date(),
    });
    userId = user!.id;
  }

  return { userId, platformRole: "super_admin" };
}
