/**
 * Runs fetch-zhwiki-family.ts across every family already imported from
 * Wikidata — the whole point of the single-target script was to mine the
 * layer Wikidata's SPARQL triples miss, and that gap exists for all ~460
 * already-seeded families, not just the one or two hand-tested so far.
 *
 * For each family this picks ONE representative person (the one whose name
 * is in the family's label, e.g. "曾国藩" for "曾国藩家族"; falling back to
 * the highest-degree node in the family graph when no name matches) and
 * mines that person's own zh.wikipedia article. A family's patriarch is the
 * one most likely to have a full biography with a proper 家庭/家世 section —
 * running every member of every family would be a much bigger, slower crawl
 * for a lot of marginal extra coverage, so this stays a first pass.
 *
 * Idempotent: a family whose review file already exists is skipped unless
 * --force is given, so an interrupted run can just be re-invoked.
 *
 * Usage:
 *   npx tsx scripts/fetch-zhwiki-family-batch.ts                # every family
 *   npx tsx scripts/fetch-zhwiki-family-batch.ts --count=10      # first 10
 *   npx tsx scripts/fetch-zhwiki-family-batch.ts --start=50 --count=20
 *   npx tsx scripts/fetch-zhwiki-family-batch.ts --keys=zeng,lihongzhang,qian
 *   npx tsx scripts/fetch-zhwiki-family-batch.ts --force          # re-fetch all
 *
 * Writes modules/genealogy/import/sources/review/<key>.zhwiki.review.json per
 * family (same review-not-source contract as the single-target script) plus
 * a run summary to modules/genealogy/import/sources/review/_batch-summary.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  wikidataFamilyKeys,
  wikidataFamilyList,
  wikidataFamilySource,
} from "@/modules/genealogy/import/sources/wikidata-families";
import type { GenealogyDataset, SourcePerson } from "@/modules/genealogy/import/types";
import { toSimplified } from "@/modules/search/hanzi";
import { fetchZhwikiFamily, type FetchZhwikiResult } from "./fetch-zhwiki-family";

const REVIEW_DIR = join(process.cwd(), "modules", "genealogy", "import", "sources", "review");

/** The person most worth mining for a family: whoever's name appears in the
 * family label (the patriarch, by how these labels were written), or — when
 * no name matches — whoever has the most relation edges (the family graph's
 * best-documented hub, a reasonable proxy for "has a real biography page"). */
function pickRepresentative(label: string, dataset: GenealogyDataset): SourcePerson | null {
  if (dataset.people.length === 0) return null;
  const byName = dataset.people
    .filter((p) => !p.living && label.includes(toSimplified(p.name)))
    .sort((a, b) => b.name.length - a.name.length)[0]; // longest match wins (avoids a 1-char surname false hit)
  if (byName) return byName;

  const degree = new Map<string, number>();
  for (const r of dataset.relations) {
    if (r.kind === "parent") {
      degree.set(r.parent, (degree.get(r.parent) ?? 0) + 1);
      degree.set(r.child, (degree.get(r.child) ?? 0) + 1);
    } else {
      degree.set(r.a, (degree.get(r.a) ?? 0) + 1);
      degree.set(r.b, (degree.get(r.b) ?? 0) + 1);
    }
  }
  const deceased = dataset.people.filter((p) => !p.living);
  const pool = deceased.length > 0 ? deceased : dataset.people;
  return [...pool].sort((a, b) => (degree.get(b.externalId) ?? 0) - (degree.get(a.externalId) ?? 0))[0] ?? null;
}

type Args = { start: number; count?: number; keys?: string[]; force: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { start: 0, force: false };
  for (const arg of argv) {
    const m = /^--(\w[\w-]*)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, name, value] = m;
    if (name === "start") args.start = Number(value ?? 0);
    else if (name === "count") args.count = Number(value);
    else if (name === "force") args.force = true;
    else if (name === "keys") args.keys = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

type RunRow = {
  key: string;
  representative: string;
  status: FetchZhwikiResult["status"] | "skipped-existing" | "no-representative";
  peopleCount?: number;
  relationsCount?: number;
};

const SUMMARY_PATH = join(REVIEW_DIR, "_batch-summary.json");

function loadPriorRows(): RunRow[] {
  if (!existsSync(SUMMARY_PATH)) return [];
  try {
    return (JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as { rows?: RunRow[] }).rows ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const labelByKey = new Map(wikidataFamilyList.map((f) => [f.key, f.label]));
  const keys = args.keys ?? wikidataFamilyKeys.slice(args.start, args.count ? args.start + args.count : undefined);

  process.stdout.write(`batch: ${keys.length} families (of ${wikidataFamilyKeys.length} total)\n`);

  // "ok" and "no-section" are deterministic — skip them on a re-run same as
  // an on-disk review file. Errors are NOT skipped: those are worth retrying
  // (transient network/throttle issues), so only a genuinely-checked article
  // gets cached.
  const priorStatusByKey = new Map(loadPriorRows().map((r) => [r.key, r.status]));

  const rows: RunRow[] = [];
  for (const [i, key] of keys.entries()) {
    const outPath = join(REVIEW_DIR, `${key}.zhwiki.review.json`);
    const progress = `[${i + 1}/${keys.length}]`;
    const priorStatus = priorStatusByKey.get(key);
    if (!args.force && (existsSync(outPath) || priorStatus === "no-section")) {
      process.stdout.write(`${progress} ${key}: already checked (${priorStatus ?? "ok"}), skipping (--force to re-fetch)\n`);
      rows.push({ key, representative: "", status: "skipped-existing" });
      continue;
    }

    const source = wikidataFamilySource(key);
    if (!source) {
      process.stdout.write(`${progress} ${key}: unknown family key, skipping\n`);
      continue;
    }
    const dataset = await source.load();
    const rep = pickRepresentative(labelByKey.get(key) ?? "", dataset);
    if (!rep) {
      process.stdout.write(`${progress} ${key}: no people in dataset, skipping\n`);
      rows.push({ key, representative: "", status: "no-representative" });
      continue;
    }

    try {
      const result = await fetchZhwikiFamily(rep.externalId, key);
      if (result.status === "ok") {
        process.stdout.write(
          `${progress} ${key} (${rep.name}): ${result.peopleCount} people, ${result.relationsCount} relations\n`,
        );
        rows.push({
          key,
          representative: rep.name,
          status: "ok",
          peopleCount: result.peopleCount,
          relationsCount: result.relationsCount,
        });
      } else if (result.status === "no-section") {
        process.stdout.write(`${progress} ${key} (${rep.name}): no 家庭 section\n`);
        rows.push({ key, representative: rep.name, status: "no-section" });
      } else {
        process.stdout.write(`${progress} ${key} (${rep.name}): ${result.error}\n`);
        rows.push({ key, representative: rep.name, status: "redirect-loop-or-missing" });
      }
    } catch (error) {
      process.stdout.write(`${progress} ${key} (${rep.name}): ERROR ${String(error)}\n`);
      rows.push({ key, representative: rep.name, status: "redirect-loop-or-missing" });
    }
  }

  const ok = rows.filter((r) => r.status === "ok");
  const totalPeople = ok.reduce((s, r) => s + (r.peopleCount ?? 0), 0);
  const totalRelations = ok.reduce((s, r) => s + (r.relationsCount ?? 0), 0);
  const summary = {
    ranAt: new Date().toISOString(),
    familiesRequested: keys.length,
    ok: ok.length,
    noSection: rows.filter((r) => r.status === "no-section").length,
    skippedExisting: rows.filter((r) => r.status === "skipped-existing").length,
    errored: rows.filter((r) => r.status === "redirect-loop-or-missing" || r.status === "no-representative").length,
    totalPeopleFound: totalPeople,
    totalRelationsFound: totalRelations,
    rows,
  };
  // Merge onto any prior summary's rows rather than clobbering, so repeated
  // partial runs (--start/--count chunks) build one cumulative picture. A
  // "skipped-existing" placeholder from *this* run must not overwrite the
  // real (richer) row a *prior* run already recorded for that key.
  const byKey = new Map(loadPriorRows().map((r) => [r.key, r]));
  for (const r of rows) if (r.status !== "skipped-existing") byKey.set(r.key, r);
  const mergedRows = [...byKey.values()];
  writeFileSync(
    SUMMARY_PATH,
    JSON.stringify({ ...summary, rows: mergedRows }, null, 2) + "\n",
    "utf8",
  );

  process.stdout.write(
    `\ndone: ${ok.length} ok, ${summary.noSection} no-section, ${summary.skippedExisting} skipped-existing, ${summary.errored} errored\n` +
      `total new: ${totalPeople} people, ${totalRelations} relations (this run)\n` +
      `summary: ${SUMMARY_PATH}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`batch failed: ${String(error)}\n`);
  process.exitCode = 1;
});
