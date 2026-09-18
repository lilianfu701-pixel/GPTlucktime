import { and, isNull, or, like } from "drizzle-orm";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";

/**
 * The external ids that already have a seeded memorial, read straight from the
 * database. The admin panel uses this to show real "已导入 N/总数" state on
 * load — the per-row click state is in memory only and resets on a reload,
 * which made fully-imported families look 待导入.
 *
 * Both source namespaces are covered: Wikidata families key on
 * `import:wikidata:{QID}` and CBDB families on `import:cbdb:{personId}`. The
 * external id is the key's last segment either way (also correct for any legacy
 * `import:{ns}:{family}:{id}` key). QIDs (Q-prefixed) and CBDB ids (numeric)
 * never collide, so one flat set serves both.
 */
export async function importedWikidataExternalIds(): Promise<Set<string>> {
  const rows = await db()
    .select({ key: memorials.creationIdempotencyKey })
    .from(memorials)
    .where(
      and(
        or(
          like(memorials.creationIdempotencyKey, "import:wikidata:%"),
          like(memorials.creationIdempotencyKey, "import:cbdb:%"),
        ),
        isNull(memorials.deletionRequestedAt),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    const externalId = row.key?.split(":").pop();
    if (externalId) ids.add(externalId);
  }
  return ids;
}
