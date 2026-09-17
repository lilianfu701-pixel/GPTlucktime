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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The public endpoint rate-limits bursts, so keep a minimum gap between every
// request (one shared queue, since all queries run through here).
const MIN_GAP_MS = 700;
let lastQueryAt = 0;
async function throttle(): Promise<void> {
  const wait = lastQueryAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastQueryAt = Date.now();
}

async function sparql(query: string, attempt = 0): Promise<Row[]> {
  await throttle();
  // POST the query in the body — a cluster's VALUES clause runs to a few hundred
  // QIDs, which overflows the endpoint's URI length limit as a GET.
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?format=json`, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: `query=${encodeURIComponent(query)}`,
    });
  } catch (error) {
    // Network blip (reset connection, DNS). Retry a few times.
    if (attempt < 6) {
      await sleep(2000 * 2 ** attempt);
      return sparql(query, attempt + 1);
    }
    throw error;
  }
  // The public endpoint returns 429 (rate limit) and 500/502/503/504 (gateway,
  // timeout) transiently under load; back off and retry rather than abort a
  // long multi-query fetch on one blip. Honour Retry-After when the server sets it.
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2000 * 2 ** attempt;
    await sleep(backoff);
    return sparql(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let json: { results: { bindings: Row[] } };
  try {
    json = (await res.json()) as { results: { bindings: Row[] } };
  } catch {
    throw new Error(
      `SPARQL response too large for: ${query.replace(/\s+/g, " ").trim().slice(0, 180)}`,
    );
  }
  return json.results.bindings;
}

const qid = (uri: string): string => uri.split("/").pop() as string;

const valuesOf = (ids: string[]): string => ids.map((id) => `wd:${id}`).join(" ");

/**
 * The walk is deliberately *directional*, because Wikidata's Chinese gentry is
 * one giant marriage-connected blob: following parent/child/sibling edges in
 * every direction from any figure wanders through in-laws into unrelated
 * lineages (曾国藩 → 聂 → 俞 → … → Carrie Fisher). So we climb the parental
 * line strictly up, the descendant line strictly down, take collateral
 * (siblings, uncles, cousins) only one hop without expanding it, and marry in
 * spouses one hop. That stays inside one family.
 */
const MAX_UP = 5; // ancestor generations
const MAX_DOWN = 5; // descendant generations
const MAX_PEOPLE = 200; // hard safety cap
/** Cap any single neighbour query, so one over-linked node can't return
 * hundreds of megabytes. Plenty for a real family; noise beyond it is dropped. */
const LEVEL_LIMIT = 300;
/** Frontier nodes per neighbour query. Larger is fine now the query is POSTed
 * (no URI limit) and each subject is capped by LEVEL_LIMIT — bigger chunks mean
 * far fewer requests, which the public endpoint's rate limiter prefers. */
const FRONTIER_CHUNK = 50;

/** DISTINCT values of `properties` (a UNION of `wdt:Pnn ?p` patterns) over a
 * seed set, chunked and LIMIT-capped so a super-connector can't bloat it. */
async function neighbours(seed: string[], properties: string[]): Promise<string[]> {
  const union = properties.map((p) => `{ ?s wdt:${p} ?p }`).join(" UNION ");
  const out = new Set<string>();
  for (let i = 0; i < seed.length; i += FRONTIER_CHUNK) {
    const chunk = seed.slice(i, i + FRONTIER_CHUNK);
    // NB: no SELECT DISTINCT — Blazegraph mis-plans `SELECT DISTINCT ?o` over a
    // VALUES-bound subject and silently drops the VALUES, scanning every triple
    // with that predicate. Plain SELECT respects the VALUES; we dedup here.
    const rows = await sparql(
      `SELECT ?p WHERE { VALUES ?s { ${valuesOf(chunk)} } ${union} } LIMIT ${LEVEL_LIMIT}`,
    );
    for (const row of rows) if (row.p) out.add(qid(row.p.value));
  }
  return [...out];
}

/** Climb one direction (parents up, or children down) from a seed, staying on
 * that single axis so the walk never turns a corner into collateral. */
async function climb(
  root: string,
  properties: string[],
  maxDepth: number,
  cap: number,
): Promise<Set<string>> {
  const line = new Set<string>([root]);
  let frontier = [root];
  for (let d = 0; d < maxDepth && frontier.length > 0 && line.size < cap; d += 1) {
    const next: string[] = [];
    for (const q of await neighbours(frontier, properties)) {
      if (!line.has(q) && line.size < cap) {
        line.add(q);
        next.push(q);
      }
    }
    frontier = next;
  }
  return line;
}

async function fetchClusterQids(root: string): Promise<string[]> {
  // Vertical lines: strictly-up ancestors and strictly-down descendants.
  const ancestors = await climb(root, ["P22", "P25"], MAX_UP, MAX_PEOPLE);
  const descendants = await climb(root, ["P40"], MAX_DOWN, MAX_PEOPLE);
  const line = new Set<string>([...ancestors, ...descendants]);

  // Collateral, one hop only, never expanded: siblings of everyone on the line,
  // plus the children of each ancestor (the root's uncles, granduncles, and
  // their offspring — 旁系). Capped, so a super-connector stays contained.
  const family = new Set(line);
  const collateral = [
    ...(await neighbours([...line], ["P3373"])),
    ...(await neighbours([...ancestors], ["P40"])),
  ];
  for (const q of collateral) if (family.size < MAX_PEOPLE) family.add(q);

  // Spouses married into the family — one hop, never expanded.
  const withSpouses = new Set(family);
  for (const q of await neighbours([...family], ["P26"])) {
    if (withSpouses.size < MAX_PEOPLE) withSpouses.add(q);
  }
  return [...withSpouses];
}
const yearOf = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  // Wikidata pads year/month precision to 01-01, so only the year is trustworthy.
  const m = /^-?(\d{1,4})/.exec(iso.replace(/^\+/, ""));
  return m ? Number(m[1]) : undefined;
};

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/** The Commons file title from a P18 Special:FilePath URL. */
function commonsTitle(photoUrl: string): string | null {
  const m = /Special:FilePath\/(.+)$/.exec(photoUrl);
  if (!m) return null;
  return `File:${decodeURIComponent(m[1]!.split("?")[0]!)}`;
}

const stripHtml = (raw: string): string => {
  const s = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Commons often nests the artist twice ("Unknown authorUnknown author").
  if (s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2)) {
    return s.slice(0, s.length / 2);
  }
  return s;
};

/**
 * Looks each image up on Commons, keeps only free licences (public domain or
 * Creative Commons), and writes a credit; a non-free image loses its photo.
 */
async function attachPhotoCredits(people: SourcePerson[]): Promise<void> {
  // The media pipeline only accepts JPEG/PNG/WebP. Drop anything else (GIF, SVG,
  // TIFF) up front, so a seed never wastes a fetch on a format it will reject.
  for (const p of people) {
    if (p.photoUrl && !/\.(jpe?g|png|webp)$/i.test(commonsTitle(p.photoUrl) ?? "")) {
      delete p.photoUrl;
    }
  }
  const titled = people
    .filter((p) => p.photoUrl)
    .map((p) => ({ p, title: commonsTitle(p.photoUrl!) }))
    .filter((x): x is { p: SourcePerson; title: string } => Boolean(x.title));
  if (titled.length === 0) return;

  const meta = new Map<string, Row>();
  // Commons takes up to 50 titles per request.
  for (let i = 0; i < titled.length; i += 40) {
    const batch = titled.slice(i, i + 40);
    const url = `${COMMONS_API}?action=query&format=json&prop=imageinfo&iiprop=extmetadata&titles=${encodeURIComponent(
      batch.map((b) => b.title).join("|"),
    )}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const json = (await res.json()) as {
      query?: { pages?: Record<string, { title: string; imageinfo?: { extmetadata?: Row }[] }> };
    };
    for (const page of Object.values(json.query?.pages ?? {})) {
      const ex = page.imageinfo?.[0]?.extmetadata;
      if (ex) meta.set(page.title, ex);
    }
  }

  for (const { p, title } of titled) {
    const ex = meta.get(title);
    const license = ex?.License?.value?.toLowerCase() ?? "";
    const shortName = ex?.LicenseShortName?.value ?? "";
    const free =
      /^(cc0|cc-|pd|public)/.test(license) ||
      /public domain|CC0|CC BY/i.test(shortName);
    if (!free) {
      // Not safe to use — drop the photo entirely.
      delete p.photoUrl;
      continue;
    }
    const artist = ex?.Artist?.value ? stripHtml(ex.Artist.value) : "";
    const isPd = /^(pd|public)/.test(license) || /public domain/i.test(shortName);
    const parts = [
      artist ? `作者：${artist}` : "",
      isPd ? "公有领域" : shortName || "自由许可",
      "来源：Wikimedia Commons",
    ].filter(Boolean);
    p.photoCredit = parts.join(" · ");
  }
}

async function main(): Promise<void> {
  const root = process.argv[2];
  const key = process.argv[3];
  if (!root || !key) {
    process.stderr.write("usage: fetch-wikidata-family.ts <rootQID> <key>\n");
    process.exitCode = 1;
    return;
  }

  // 1) Cluster membership: a bounded family walk (blood + married-in spouses).
  const ids = await fetchClusterQids(root);
  const inSet = new Set(ids);

  // 2) Attributes. Split so a person with several images or dates does not
  // cross-product with the other properties and blow the response up. These
  // project ?p (the VALUES var), which Blazegraph binds correctly with a plain
  // VALUES — the DISTINCT-over-object mis-plan does not apply here.
  const values = valuesOf(ids);
  const labelRows = await sparql(`
    SELECT ?p ?zh ?en ?descZh ?descEn WHERE {
      VALUES ?p { ${values} }
      OPTIONAL { ?p rdfs:label ?zh . FILTER(lang(?zh)="zh") }
      OPTIONAL { ?p rdfs:label ?en . FILTER(lang(?en)="en") }
      OPTIONAL { ?p schema:description ?descZh . FILTER(lang(?descZh)="zh") }
      OPTIONAL { ?p schema:description ?descEn . FILTER(lang(?descEn)="en") }
    }`);
  const single = async (property: string): Promise<Map<string, string>> => {
    const rows = await sparql(
      `SELECT ?p ?v WHERE { VALUES ?p { ${values} } ?p wdt:${property} ?v }`,
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      const id = qid(row.p!.value);
      if (!map.has(id) && row.v) map.set(id, row.v.value);
    }
    return map;
  };
  const genderOf = await single("P21");
  const birthOf = await single("P569");
  const deathOf = await single("P570");
  const imageOf = await single("P18");

  const now = new Date().getUTCFullYear();
  const byId = new Map<string, SourcePerson>();
  for (const row of labelRows) {
    const id = qid(row.p!.value);
    if (byId.has(id)) continue;
    const zh = row.zh?.value;
    const en = row.en?.value;
    // 简体 as the primary name for the zh-CN-first site; keep the original 繁体
    // (and the English name) as searchable aliases.
    const name = zh ? toSimplified(zh) : en;
    if (!name) continue;
    const birthYear = yearOf(birthOf.get(id));
    const deathYear = yearOf(deathOf.get(id));
    const g = genderOf.get(id);
    const gender =
      g && qid(g) === MALE ? "male" : g && qid(g) === FEMALE ? "female" : undefined;
    // Living only when a recent birth is actually recorded and no death is —
    // a person with no dates at all is an old record, not someone alive.
    const living = !deathYear && birthYear !== undefined && birthYear > now - 100;
    const person: SourcePerson = {
      externalId: id,
      name,
      citation: `维基百科 / Wikidata ${id}`,
    };
    const aliases = [zh, en].filter(
      (a): a is string => Boolean(a) && a !== name,
    );
    if (aliases.length > 0) person.aliases = [...new Set(aliases)];
    if (gender) person.gender = gender;
    if (birthYear) person.birth = { year: birthYear };
    if (deathYear) person.death = { year: deathYear };
    if (living) person.living = true;
    const bio = row.descZh?.value ?? row.descEn?.value;
    if (bio) person.bio = bio;
    const img = imageOf.get(id);
    if (img) person.photoUrl = img;
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

  // 4) Photo licences from Wikimedia Commons. Keep only freely-licensed images
  // and attach a credit; drop the rest (and their photo) rather than risk using
  // a non-free image.
  await attachPhotoCredits([...byId.values()]);

  const dataset: GenealogyDataset = {
    key: `wikidata:${key}`,
    // All Wikidata families share one identity namespace, so a person in two
    // families (a QID) is one page, not a duplicate.
    namespace: "wikidata",
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
