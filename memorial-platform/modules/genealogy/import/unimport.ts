import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { deceasedPeople, familyPeople, memorials } from "@/db/schema";
import { identityKey } from "./importer";
import { ensureImportStewardActor } from "./steward";
import type { GenealogyDataset } from "./types";

export type UnimportReport = {
  source: string;
  /** Seed pages removed. */
  memorialsDeleted: number;
  /** Masked living nodes removed. */
  livingDeleted: number;
  /**
   * Seeds left in place because a family has since claimed them — a claimed page
   * or a claimed self-node is no longer the platform's to delete.
   */
  skippedClaimed: number;
};

/**
 * Removes exactly the people in one dataset, and nothing else.
 *
 * The safety net for a bad seed: it deletes the pages and nodes whose identity
 * keys are in this dataset — never a page a real family created. Claim-aware: a
 * seed a descendant has taken over (ownership transferred, or a self-node
 * claimed) is left untouched. With a shared namespace a person may belong to
 * several families, so removing this dataset removes them from the others too —
 * re-import the other family to restore them.
 *
 * Order follows the keys: a memorial holds a `restrict` reference to its deceased
 * person, so the memorial goes first; deleting the deceased person then cascades
 * to that person's tree node and its links. Living nodes carry no page and are
 * deleted directly (their links cascade). All in one transaction.
 */
export async function unimportGenealogy(
  dataset: GenealogyDataset,
): Promise<UnimportReport> {
  const keys = dataset.people.map((p) => identityKey(dataset, p.externalId));
  const steward = await ensureImportStewardActor();

  return db().transaction(async (tx) => {
    const report: UnimportReport = {
      source: dataset.key,
      memorialsDeleted: 0,
      livingDeleted: 0,
      skippedClaimed: 0,
    };

    if (keys.length === 0) return report;

    // Seed pages of this dataset, split into still-stewarded (ours to remove) and
    // since-claimed (left alone).
    const seededMemorials = await tx
      .select({
        id: memorials.id,
        deceasedPersonId: memorials.deceasedPersonId,
        ownerUserId: memorials.ownerUserId,
      })
      .from(memorials)
      .where(inArray(memorials.creationIdempotencyKey, keys));

    const removableMemorialIds: string[] = [];
    const removableDeceasedIds: string[] = [];
    for (const m of seededMemorials) {
      if (m.ownerUserId === steward.userId) {
        removableMemorialIds.push(m.id);
        removableDeceasedIds.push(m.deceasedPersonId);
      } else {
        report.skippedClaimed += 1;
      }
    }

    if (removableMemorialIds.length > 0) {
      // Memorial first (its children cascade), then the deceased person (which
      // cascades that person's family-tree node and edges).
      await tx.delete(memorials).where(inArray(memorials.id, removableMemorialIds));
      await tx
        .delete(deceasedPeople)
        .where(inArray(deceasedPeople.id, removableDeceasedIds));
      report.memorialsDeleted = removableMemorialIds.length;
    }

    // Living masked nodes of this batch, unless someone has claimed themselves.
    const livingNodes = await tx
      .select({ id: familyPeople.id, selfUserId: familyPeople.selfUserId })
      .from(familyPeople)
      .where(
        and(
          inArray(familyPeople.importKey, keys),
          isNull(familyPeople.deceasedPersonId),
        ),
      );

    const removableLiving = livingNodes
      .filter((n) => {
        if (n.selfUserId) {
          report.skippedClaimed += 1;
          return false;
        }
        return true;
      })
      .map((n) => n.id);

    if (removableLiving.length > 0) {
      await tx.delete(familyPeople).where(inArray(familyPeople.id, removableLiving));
      report.livingDeleted = removableLiving.length;
    }

    return report;
  });
}
