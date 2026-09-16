import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { familyPeople, memorials } from "@/db/schema";
import { createMemorial } from "@/modules/memorials/service";
import type { CreateMemorialInput, PartialDate } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";
import { addLivingRelative, addMemorialSubject } from "../people";
import { proposeLink } from "../links";
import type {
  GenealogyDataset,
  SourceDate,
  SourcePerson,
  SourceRelation,
} from "./types";

/** A cross-strait Chinese figure belongs in all three Chinese channels. */
const DEFAULT_REGIONS = ["zh-CN", "zh-TW", "zh-HK"] as const;

export type ImportOptions = {
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  /** Channels the seeded pages belong to. Defaults to the three Chinese ones. */
  regions?: readonly string[];
  /** Correlation id threaded through the audit trail for one import run. */
  correlationId?: string;
  /**
   * Skip living people entirely — seed only the deceased generations. The safe
   * default for a first production seed: no living individual's node is planted
   * until that is a deliberate choice, and relations that touch a skipped living
   * person are dropped quietly rather than logged as missing.
   */
  skipLiving?: boolean;
};

export type ImportIssue = {
  externalId?: string;
  stage: "validate" | "memorial" | "living" | "link";
  error: string;
};

export type ImportedMemorial = {
  externalId: string;
  memorialId: string;
  slug: string;
  name: string;
  created: boolean;
};

export type ImportReport = {
  source: string;
  dryRun: boolean;
  peopleTotal: number;
  relationsTotal: number;
  memorialsCreated: number;
  memorialsExisting: number;
  /** Living people seeded as masked graph nodes (no page). */
  livingCreated: number;
  livingExisting: number;
  linksCreated: number;
  linksExisting: number;
  issues: ImportIssue[];
  memorials: ImportedMemorial[];
};

/**
 * The per-person idempotency key.
 *
 * Deterministic in (source, externalId), so re-running an import returns the
 * page made last time instead of a second one — `createMemorial` looks the key
 * up and replays. This is also how a later run resolves an external id back to
 * its memorial to wire the relations, without a separate mapping table.
 */
function idempotencyKey(sourceKey: string, externalId: string): string {
  return `import:${sourceKey}:${externalId}`;
}

/** A source date to the memorial's partial-date shape, at the precision known. */
function toPartialDate(d: SourceDate | undefined): PartialDate | undefined {
  if (!d) return undefined;
  const year = String(d.year).padStart(4, "0");
  const month = d.month ? String(d.month).padStart(2, "0") : "01";
  const day = d.day ? String(d.day).padStart(2, "0") : "01";
  const precision = d.day ? "day" : d.month ? "month" : "year";
  return { value: `${year}-${month}-${day}`, precision };
}

function buildInput(
  person: SourcePerson,
  regions: readonly string[],
): CreateMemorialInput {
  const locations: NonNullable<CreateMemorialInput["locations"]> = [];
  if (person.birthPlace) locations.push({ kind: "birth", ...person.birthPlace });
  if (person.deathPlace) locations.push({ kind: "death", ...person.deathPlace });

  const birthDate = toPartialDate(person.birth);
  const deathDate = toPartialDate(person.death);

  return {
    // Staff-stewarded: no family relationship is declared, offerings stay closed
    // until a descendant claims the page, and the declaration step is skipped.
    asAdminSteward: true,
    relationship: "child",
    relationshipStatementAccepted: false,
    primaryName: { value: person.name, locale: "zh-CN", script: "Hans" },
    ...(person.aliases && person.aliases.length > 0
      ? {
          aliases: person.aliases.map((value) => ({
            value,
            locale: "zh-CN",
            script: "Hans",
            searchable: true,
          })),
        }
      : {}),
    ...(person.gender && person.gender !== "unknown"
      ? { gender: person.gender }
      : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(deathDate ? { deathDate } : {}),
    ...(person.ancestralHometown
      ? { ancestralHometown: person.ancestralHometown }
      : {}),
    ...(locations.length > 0 ? { locations } : {}),
    visibility: "public",
    searchEngineIndexable: true,
    regions: [...regions],
  };
}

/**
 * Imports a normalized dataset into the platform as claimable seed memorials
 * wired into the family graph.
 *
 * Runs as one staff actor who ends up stewarding every page, which is what lets
 * the parent and spouse edges confirm on creation (a link between two pages the
 * same actor stewards has no second family to ask). The result is a connected,
 * traversable graph — so the kinship engine can already derive grandparents,
 * uncles and cousins the source never stated — sitting behind pages that any
 * descendant can later claim.
 *
 * Idempotent: creating a page and linking a pair both no-op on a second run.
 */
export async function importGenealogy(
  actor: Actor,
  dataset: GenealogyDataset,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const regions = options.regions ?? DEFAULT_REGIONS;
  const correlationId = options.correlationId ?? `import-${dataset.key}`;
  const dryRun = options.dryRun ?? false;

  const report: ImportReport = {
    source: dataset.key,
    dryRun,
    peopleTotal: dataset.people.length,
    relationsTotal: dataset.relations.length,
    memorialsCreated: 0,
    memorialsExisting: 0,
    livingCreated: 0,
    livingExisting: 0,
    linksCreated: 0,
    linksExisting: 0,
    issues: [],
    memorials: [],
  };

  // Validate before touching the database: unique ids, and every relation
  // pointing at people the dataset actually contains.
  const ids = new Set<string>();
  for (const person of dataset.people) {
    if (ids.has(person.externalId)) {
      report.issues.push({
        externalId: person.externalId,
        stage: "validate",
        error: "duplicate externalId",
      });
    }
    ids.add(person.externalId);
    if (!person.name.trim()) {
      report.issues.push({
        externalId: person.externalId,
        stage: "validate",
        error: "empty name",
      });
    }
  }
  for (const rel of dataset.relations) {
    const refs = rel.kind === "parent" ? [rel.parent, rel.child] : [rel.a, rel.b];
    for (const ref of refs) {
      if (!ids.has(ref)) {
        report.issues.push({
          stage: "validate",
          error: `relation references unknown id ${ref}`,
        });
      }
    }
  }

  if (dryRun) {
    // A dry run reports the plan; it neither creates pages nor resolves ids.
    return report;
  }

  if (report.issues.some((i) => i.stage === "validate")) {
    // A malformed dataset would produce a half-wired graph; refuse it whole.
    return report;
  }

  // Pass one: a graph node per person, collecting external id → node id. A
  // deceased person gets a claimable memorial behind their node; a living person
  // gets a masked node with no page. Both carry their 字辈 for later matching.
  const nodeByExternalId = new Map<string, string>();
  const skipped = new Set<string>();
  for (const person of dataset.people) {
    if (person.living && options.skipLiving) {
      skipped.add(person.externalId);
      continue;
    }
    const nodeId = person.living
      ? await seedLivingNode(actor, dataset, person, correlationId, report)
      : await seedMemorialNode(actor, dataset, person, regions, correlationId, report);
    if (nodeId) nodeByExternalId.set(person.externalId, nodeId);
  }

  // Pass two: the edges, between graph nodes directly. Every node is this
  // actor's to speak for, so each proposed link confirms at once and is
  // traversable — a connected 族谱, not a pile of proposals. An edge to a
  // deliberately skipped living person is dropped quietly.
  for (const rel of dataset.relations) {
    const refs = rel.kind === "parent" ? [rel.parent, rel.child] : [rel.a, rel.b];
    if (refs.some((ref) => skipped.has(ref))) continue;
    await applyRelation(actor, rel, nodeByExternalId, correlationId, report);
  }

  return report;
}

/** Sets a graph node's 字辈, once, after it is created. */
async function setGenerationName(
  personId: string,
  generationName: string | undefined,
): Promise<void> {
  if (!generationName) return;
  await db()
    .update(familyPeople)
    .set({ generationName })
    .where(eq(familyPeople.id, personId));
}

/** A deceased person: a claimable seed memorial, placed in the graph. */
async function seedMemorialNode(
  actor: Actor,
  dataset: GenealogyDataset,
  person: SourcePerson,
  regions: readonly string[],
  correlationId: string,
  report: ImportReport,
): Promise<string | null> {
  const result = await createMemorial(
    actor,
    buildInput(person, regions),
    idempotencyKey(dataset.key, person.externalId),
    correlationId,
  );
  if (!result.ok) {
    report.issues.push({
      externalId: person.externalId,
      stage: "memorial",
      error: result.error,
    });
    return null;
  }

  // A stewarded seed is created as a draft; publish it so the public page and
  // its family section render for a searcher or a would-be claimant.
  if (result.value.created) {
    await db()
      .update(memorials)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(memorials.id, result.value.memorialId));
    report.memorialsCreated += 1;
  } else {
    report.memorialsExisting += 1;
  }

  report.memorials.push({
    externalId: person.externalId,
    memorialId: result.value.memorialId,
    slug: result.value.slug,
    name: person.name,
    created: result.value.created,
  });

  // Placing the subject in the graph returns its node id (idempotent).
  const placed = await addMemorialSubject(actor, result.value.memorialId, correlationId);
  if (!placed.ok) {
    report.issues.push({
      externalId: person.externalId,
      stage: "memorial",
      error: placed.error,
    });
    return null;
  }
  await setGenerationName(placed.value.personId, person.generationName);
  return placed.value.personId;
}

/**
 * A living person: a masked graph node, never a page.
 *
 * Only a name and a birth year are recorded — enough to place them in the tree
 * and to match a descendant who registers, and no more, since this person has
 * not consented to anything. `publicMasked` lets the tree show a surname-only
 * name rather than a blank; the full name stays for matching, never displayed.
 */
async function seedLivingNode(
  actor: Actor,
  dataset: GenealogyDataset,
  person: SourcePerson,
  correlationId: string,
  report: ImportReport,
): Promise<string | null> {
  // Idempotent by (source, externalId): reuse an existing seeded node.
  const externalKey = idempotencyKey(dataset.key, person.externalId);
  const [existing] = await db()
    .select({ id: familyPeople.id })
    .from(familyPeople)
    .where(eq(familyPeople.importKey, externalKey));
  if (existing) {
    report.livingExisting += 1;
    return existing.id;
  }

  const placed = await addLivingRelative(
    actor,
    {
      displayName: person.name,
      ...(person.birth ? { birthYear: person.birth.year } : {}),
    },
    correlationId,
  );
  if (!placed.ok) {
    report.issues.push({
      externalId: person.externalId,
      stage: "living",
      error: placed.error,
    });
    return null;
  }

  await db()
    .update(familyPeople)
    .set({
      publicMasked: true,
      importKey: externalKey,
      ...(person.generationName ? { generationName: person.generationName } : {}),
    })
    .where(eq(familyPeople.id, placed.value.personId));

  report.livingCreated += 1;
  return placed.value.personId;
}

async function applyRelation(
  actor: Actor,
  rel: SourceRelation,
  nodeByExternalId: Map<string, string>,
  correlationId: string,
  report: ImportReport,
): Promise<void> {
  const [fromExternal, toExternal] =
    rel.kind === "parent" ? [rel.parent, rel.child] : [rel.a, rel.b];

  const fromId = nodeByExternalId.get(fromExternal);
  const toId = nodeByExternalId.get(toExternal);
  if (!fromId || !toId) {
    report.issues.push({
      stage: "link",
      error: `relation skipped, missing node for ${!fromId ? fromExternal : toExternal}`,
    });
    return;
  }

  const result = await proposeLink(
    actor,
    rel.kind === "parent"
      ? { kind: "parent", parentId: fromId, childId: toId }
      : { kind: "partner", personId: fromId, partnerId: toId },
    correlationId,
  );

  if (result.ok) {
    report.linksCreated += 1;
    return;
  }
  if (result.error === "ALREADY_LINKED") {
    // A second run re-proposing the same pair — the edge is already there.
    report.linksExisting += 1;
    return;
  }
  report.issues.push({ stage: "link", error: result.error });
}
