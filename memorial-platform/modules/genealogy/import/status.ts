import { and, isNull, like } from "drizzle-orm";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";

/**
 * The external ids (QIDs) that already have a seeded memorial, read straight
 * from the database. The admin panel uses this to show real "已导入 N/总数"
 * state on load — the per-row click state is in memory only and resets on a
 * reload, which made fully-imported families look 待导入.
 *
 * Every Wikidata family shares the `import:wikidata:{externalId}` identity key,
 * so one prefix query covers them all; the external id is the key's last
 * segment (also correct for any legacy `import:wikidata:{family}:{id}` key).
 */
export async function importedWikidataExternalIds(): Promise<Set<string>> {
  const rows = await db()
    .select({ key: memorials.creationIdempotencyKey })
    .from(memorials)
    .where(
      and(
        like(memorials.creationIdempotencyKey, "import:wikidata:%"),
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
