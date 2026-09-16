import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";
import { createMemorial } from "@/modules/memorials/service";
import type { CreateMemorialInput, PartialDate } from "@/modules/memorials/service";
import type { Actor } from "@/modules/permissions/types";
import { linkMemorials } from "../memorial-graph";
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
};

export type ImportIssue = {
  externalId?: string;
  stage: "validate" | "memorial" | "link";
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

  // Pass one: a page per person, collecting external id → memorial id.
  const memorialByExternalId = new Map<string, string>();
  for (const person of dataset.people) {
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
      continue;
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

    memorialByExternalId.set(person.externalId, result.value.memorialId);
    report.memorials.push({
      externalId: person.externalId,
      memorialId: result.value.memorialId,
      slug: result.value.slug,
      name: person.name,
      created: result.value.created,
    });
  }

  // Pass two: the edges. Both endpoints are stewarded by this actor, so each
  // link confirms immediately and becomes traversable.
  for (const rel of dataset.relations) {
    await applyRelation(actor, rel, memorialByExternalId, correlationId, report);
  }

  return report;
}

async function applyRelation(
  actor: Actor,
  rel: SourceRelation,
  memorialByExternalId: Map<string, string>,
  correlationId: string,
  report: ImportReport,
): Promise<void> {
  const [fromExternal, toExternal] =
    rel.kind === "parent" ? [rel.child, rel.parent] : [rel.a, rel.b];

  const fromId = memorialByExternalId.get(fromExternal);
  const toId = memorialByExternalId.get(toExternal);
  if (!fromId || !toId) {
    report.issues.push({
      stage: "link",
      error: `relation skipped, missing memorial for ${!fromId ? fromExternal : toExternal}`,
    });
    return;
  }

  // From the child's perspective the other side is a parent; a spouse edge is
  // symmetric, so either direction reads the same.
  const relation = rel.kind === "parent" ? "parent" : "spouse";
  const result = await linkMemorials(actor, fromId, toId, relation, correlationId);

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
