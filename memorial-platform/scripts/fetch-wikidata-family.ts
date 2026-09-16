/**
 * Snapshots a family cluster from Wikidata into a committed JSON dataset.
 *
 * Run once, by hand, to produce a reviewable fixture — the import then reads the
 * snapshot, so a seed (local or on the admin panel) never depends on Wikidata
 * being reachable, and the data can be eyeballed before it goes near production.
 *
 *   npx tsx scripts/fetch-wikidata-family.ts Q702111 soong
 *
 * The cluster is the root's blood component (ancestors, descendants, siblings —
 * "旁系") plus the spouses married into it ("配偶"); it does not wander out
 * through a spouse into their own separate family. Years only, never a fabricated
 * exact date. A living person (no recorded death, born within ~a century) is
 * flagged so the import masks them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toSimplified } from "@/modules/search/hanzi";
import type {
  GenealogyDataset,
  SourcePerson,
  SourceRelation,
} from "@/modules/genealogy/import/types";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "missingu-genealogy/1.0 (https://missingu.org)";
const MALE = "Q6581097";
const FEMALE = "Q6581072";

type Row = Record<string, { value: string } | undefined>;

async function sparql(query: string): Promise<Row[]> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { results: { bindings: Row[] } };
  return json.results.bindings;
}

const qid = (uri: string): string => uri.split("/").pop() as string;
const yearOf = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  // Wikidata pads year/month precision to 01-01, so only the year is trustworthy.
  const m = /^-?(\d{1,4})/.exec(iso.replace(/^\+/, ""));
  return m ? Number(m[1]) : undefined;
};

async function main(): Promise<void> {
  const root = process.argv[2];
  const key = process.argv[3];
  if (!root || !key) {
    process.stderr.write("usage: fetch-wikidata-family.ts <rootQID> <key>\n");
    process.exitCode = 1;
    return;
  }

  // 1) Cluster membership: blood component + married-in spouses.
  const clusterRows = await sparql(`
    SELECT DISTINCT ?person WHERE {
      { BIND(wd:${root} AS ?person) }
      UNION { wd:${root} (wdt:P40|wdt:P22|wdt:P25)+ ?person }
      UNION { wd:${root} (wdt:P40|wdt:P22|wdt:P25)* ?b . ?b wdt:P3373 ?person }
      UNION { wd:${root} (wdt:P40|wdt:P22|wdt:P25)* ?b . ?b wdt:P26 ?person }
    }`);
  const ids = [...new Set(clusterRows.map((r) => qid(r.person!.value)))];
  const inSet = new Set(ids);
  const values = ids.map((id) => `wd:${id}`).join(" ");

  // 2) Attributes for each person.
  const attrRows = await sparql(`
    SELECT ?p ?zh ?en ?gender ?birth ?death ?img ?descZh ?descEn WHERE {
      VALUES ?p { ${values} }
      OPTIONAL { ?p rdfs:label ?zh . FILTER(lang(?zh)="zh") }
      OPTIONAL { ?p rdfs:label ?en . FILTER(lang(?en)="en") }
      OPTIONAL { ?p wdt:P21 ?gender }
      OPTIONAL { ?p wdt:P569 ?birth }
      OPTIONAL { ?p wdt:P570 ?death }
      OPTIONAL { ?p wdt:P18 ?img }
      OPTIONAL { ?p schema:description ?descZh . FILTER(lang(?descZh)="zh") }
      OPTIONAL { ?p schema:description ?descEn . FILTER(lang(?descEn)="en") }
    }`);

  const now = new Date().getUTCFullYear();
  const byId = new Map<string, SourcePerson>();
  for (const row of attrRows) {
    const id = qid(row.p!.value);
    const zh = row.zh?.value;
    const en = row.en?.value;
    // 简体 as the primary name for the zh-CN-first site; keep the original 繁体
    // (and the English name) as searchable aliases.
    const name = zh ? toSimplified(zh) : en;
    if (!name) continue;
    const existing = byId.get(id);
    const birthYear = yearOf(row.birth?.value);
    const deathYear = yearOf(row.death?.value);
    const gender =
      row.gender && qid(row.gender.value) === MALE
        ? "male"
        : row.gender && qid(row.gender.value) === FEMALE
          ? "female"
          : undefined;
    // Living only when a recent birth is actually recorded and no death is —
    // a person with no dates at all is an old record, not someone alive.
    const living = !deathYear && birthYear !== undefined && birthYear > now - 100;
    const person: SourcePerson = existing ?? {
      externalId: id,
      name,
      citation: `维基百科 / Wikidata ${id}`,
    };
    if (!person.aliases) {
      const aliases = [zh, en].filter(
        (a): a is string => Boolean(a) && a !== name,
      );
      if (aliases.length > 0) person.aliases = [...new Set(aliases)];
    }
    if (gender) person.gender = gender;
    if (birthYear) person.birth = { year: birthYear };
    if (deathYear) person.death = { year: deathYear };
    if (living) person.living = true;
    const bio = row.descZh?.value ?? row.descEn?.value;
    if (bio && !person.bio) person.bio = bio;
    if (row.img?.value && !person.photoUrl) person.photoUrl = row.img.value;
    byId.set(id, person);
  }

  // 3) Edges, kept only when both ends are in the cluster.
  const parentRows = await sparql(`
    SELECT ?child ?parent WHERE {
      VALUES ?child { ${values} }
      { ?child wdt:P22 ?parent } UNION { ?child wdt:P25 ?parent }
    }`);
  const spouseRows = await sparql(`
    SELECT ?a ?b WHERE { VALUES ?a { ${values} } ?a wdt:P26 ?b }`);

  const relations: SourceRelation[] = [];
  const seen = new Set<string>();
  for (const row of parentRows) {
    const child = qid(row.child!.value);
    const parent = qid(row.parent!.value);
    if (!inSet.has(parent) || !byId.has(child) || !byId.has(parent)) continue;
    const k = `p:${parent}>${child}`;
    if (seen.has(k)) continue;
    seen.add(k);
    relations.push({ kind: "parent", parent, child });
  }
  for (const row of spouseRows) {
    const a = qid(row.a!.value);
    const b = qid(row.b!.value);
    if (!inSet.has(b) || !byId.has(a) || !byId.has(b)) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `s:${x}-${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    relations.push({ kind: "spouse", a: x, b: y });
  }

  const dataset: GenealogyDataset = {
    key: `wikidata:${key}`,
    people: [...byId.values()].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    relations,
  };

  const out = join(
    process.cwd(),
    "modules",
    "genealogy",
    "import",
    "sources",
    `${key}.data.json`,
  );
  writeFileSync(out, JSON.stringify(dataset, null, 2) + "\n", "utf8");
  const living = dataset.people.filter((p) => p.living).length;
  const photos = dataset.people.filter((p) => p.photoUrl).length;
  const bios = dataset.people.filter((p) => p.bio).length;
  process.stdout.write(
    `wrote ${out}\n  people=${dataset.people.length} (living=${living}, photos=${photos}, bios=${bios})\n  relations=${dataset.relations.length}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fetch failed: ${String(error)}\n`);
  process.exitCode = 1;
});
