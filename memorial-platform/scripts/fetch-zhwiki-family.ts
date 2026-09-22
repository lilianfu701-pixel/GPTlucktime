/**
 * Mines a zh.wikipedia article's "家庭"/"家世"/"家族" section for genealogy
 * relations that never made it into Wikidata as structured triples.
 *
 * Wikidata only has what someone bothered to turn into a P22/P25/P26/P40
 * statement — usually just father, mother, one or two siblings, sometimes a
 * spouse. The same article's prose almost always has more: an Ahnentafel
 * ancestor chart going back 3-4 generations on both the paternal and maternal
 * side, plus a flat list of spouse/children/grandchildren/siblings that is
 * never transcribed back into Wikidata. For 陈寅恪 this script found ~18
 * relations against Wikidata's 3.
 *
 * Two extraction passes, both scoped to the family section's wikitext only:
 *
 *   1. Ahnentafel template ({{Ahnentafel-compact5|1=...|2=...|...}}) — the
 *      classic binary numbering (father of N = 2N, mother of N = 2N+1) is
 *      unambiguous, so this pass is high-confidence.
 *   2. Flat kinship-labelled lines ("父：X", "长女X＝Y", "弟：A、B") — a small
 *      state machine tracks "whose child am I currently listing" so that a
 *      grandchild line right after a daughter's line attaches to the
 *      daughter, not to the root. Confidence is lower: text this loose can
 *      misparse, which is exactly why this writes a *review* file, not a
 *      source file the importer reads.
 *
 * Extracted names are resolved back to Wikidata QIDs where possible (via the
 * article's own wikilinks + MediaWiki pageprops), so a person who already has
 * a page from the Wikidata fetch merges instead of duplicating. A name with no
 * resolvable QID gets a synthetic `zhwiki:<title>` id and is called out in the
 * `unresolved` list — a human either finds the real QID or accepts the
 * synthetic one before this ever reaches `${key}.data.json`.
 *
 * Usage:
 *   npx tsx scripts/fetch-zhwiki-family.ts 陈寅恪 chenyinke
 *   npx tsx scripts/fetch-zhwiki-family.ts Q714824 chenyinke   (QID also accepted)
 *
 * Writes modules/genealogy/import/sources/review/<key>.zhwiki.review.json —
 * never the accepted `sources/*.data.json` shape directly. Promote by hand
 * after eyeballing `unresolved` and `notes`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toSimplified } from "@/modules/search/hanzi";
import type { SourceRelation } from "@/modules/genealogy/import/types";

const ZHWIKI_API = "https://zh.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const UA = "missingu-genealogy/1.0 (https://missingu.org)";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MIN_GAP_MS = 700;
let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function api<T>(base: string, params: Record<string, string>, attempt = 0): Promise<T> {
  await throttle();
  const url = `${base}?${new URLSearchParams({ format: "json", ...params }).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA } });
  } catch (error) {
    if (attempt < 5) {
      await sleep(1500 * 2 ** attempt);
      return api(base, params, attempt + 1);
    }
    throw error;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await sleep(1500 * 2 ** attempt);
    return api(base, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`${base} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Step 1: resolve the target to a zh.wikipedia title + (if known) root QID.
// ---------------------------------------------------------------------------

async function titleFromQid(qid: string): Promise<string> {
  const json = await api<{
    entities: Record<string, { sitelinks?: Record<string, { title: string }> }>;
  }>(WIKIDATA_API, { action: "wbgetentities", ids: qid, props: "sitelinks" });
  const title = json.entities[qid]?.sitelinks?.zhwiki?.title;
  if (!title) throw new Error(`${qid} has no zhwiki sitelink`);
  return title;
}

// ---------------------------------------------------------------------------
// Step 2: fetch the article's wikitext and isolate the family section.
// ---------------------------------------------------------------------------

type RevisionResponse = {
  query?: { pages?: { title: string; revisions?: { slots?: { main?: { content: string } } }[] }[] };
};

async function fetchWikitext(title: string): Promise<{ title: string; content: string }> {
  const json = await api<RevisionResponse>(ZHWIKI_API, {
    action: "query",
    prop: "revisions",
    rvslots: "main",
    rvprop: "content",
    titles: title,
    redirects: "1", // e.g. 胡适 -> 胡適 (simplified/traditional canonical-title redirects are common)
    formatversion: "2",
  });
  const page = json.query?.pages?.[0];
  const content = page?.revisions?.[0]?.slots?.main?.content;
  if (!content) throw new Error(`no wikitext for "${title}" (missing page or moved)`);
  return { title: page?.title ?? title, content };
}

/** Section headings this kind of content shows up under, in practice. */
const FAMILY_HEADING = /^家[庭世族](编辑)?$|^家世[与及]家族(编辑)?$/;

/**
 * Everything between each `== 家庭 ==`-style heading and the next heading at
 * the same or a shallower level, concatenated. An article commonly has more
 * than one of these — e.g. a "家世" prose subsection under 生平 early on,
 * *and* a separate "家庭" section near the end holding the actual Ahnentafel
 * chart — so every match is collected rather than stopping at the first.
 */
function extractFamilySections(wikitext: string): string[] {
  const headingRe = /^(=+)\s*(.+?)\s*=+\s*$/gm;
  const headings: { level: number; title: string; bodyStart: number; headingStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(wikitext))) {
    headings.push({
      level: match[1]!.length,
      title: match[2]!.trim(),
      bodyStart: match.index + match[0].length,
      headingStart: match.index,
    });
  }
  const sections: string[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i]!;
    if (!FAMILY_HEADING.test(h.title)) continue;
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    const end = next ? next.headingStart : wikitext.length;
    sections.push(wikitext.slice(h.bodyStart, end));
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Text cleanup helpers shared by both extraction passes.
// ---------------------------------------------------------------------------

/** A raw name as it appeared in wikitext, plus the wikilink title if any
 * (the wikilink title is what MediaWiki pageprops resolves to a QID). */
type RawName = { display: string; linkTitle?: string };

function stripNoise(raw: string): string {
  return raw
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "") // inline citation templates ({{r|...}} etc.)
    .replace(/'''?/g, "")
    .replace(/（[^（）]*）|\([^()]*\)/g, "") // parenthetical asides (dates, notes)
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
}

/** An Ahnentafel param's value is often "label：name" ("祖母：黄淑贞") rather
 * than the bare name — the label describes the slot, the name is what we
 * want. Strip a leading short run of non-punctuation characters + colon. */
function stripLeadingLabel(s: string): string {
  return s.replace(/^[^\s:：[\]]{1,6}[:：]\s*/, "");
}

/** Pull the first `[[Title|Display]]` / `[[Title]]` out of a cell, falling
 * back to the cleaned plain text when there is no wikilink. */
function firstName(raw: string): RawName | null {
  const cleaned = stripLeadingLabel(stripNoise(raw));
  const link = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(cleaned);
  if (link) {
    const linkTitle = link[1]!.trim();
    const display = (link[2] ?? link[1]!).trim();
    return display ? { display, linkTitle } : null;
  }
  const plain = cleaned.replace(/\[\[|\]\]/g, "").trim();
  return plain ? { display: plain } : null;
}

/** Split a cell that lists several people ("陈衡恪、陈隆恪" / "A，B" / "A/B")
 * into individual names, each still wikilink-aware. */
function splitNames(raw: string): RawName[] {
  const cleaned = stripNoise(raw);
  const parts = cleaned.split(/[、，,;；]|\s+及\s+|\s+和\s+/).map((s) => s.trim()).filter(Boolean);
  const out: RawName[] = [];
  for (const part of parts) {
    const name = firstName(part);
    if (name) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass 1: {{Ahnentafel...}} ancestor chart — binary numbering, high confidence.
// ---------------------------------------------------------------------------

// Find each `{{ahnentafel-compact5 ... }}` block by its closing `}}` on its
// own line, then walk it line-by-line rather than splitting on `|`: a param
// value routinely contains its own `|`-delimited template on the same line
// (e.g. `|5=...<ref>...{{Wayback|url=...|date=...}}...</ref>`), which a
// naive "value ends at the next `|`" regex would truncate mid-citation.
const AHNENTAFEL_BLOCK_RE = /\{\{\s*ahnentafel[-\w]*([\s\S]*?)\n\}\}/gi;

/** So the flat-line pass never re-processes (or flags as "unparsed") the raw
 * `|N=...` param lines that parseAhnentafel already consumed. */
function stripAhnentafelBlocks(section: string): string {
  return section.replace(AHNENTAFEL_BLOCK_RE, "");
}

function parseAhnentafel(section: string): { nodes: Map<number, RawName>; relations: { n: number; father?: number; mother?: number }[] } {
  const nodes = new Map<number, RawName>();
  const blockRe = new RegExp(AHNENTAFEL_BLOCK_RE.source, AHNENTAFEL_BLOCK_RE.flags);
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(section))) {
    let currentN: number | null = null;
    let currentValue = "";
    const flush = (): void => {
      if (currentN !== null) {
        const name = firstName(currentValue);
        if (name && !nodes.has(currentN)) nodes.set(currentN, name);
      }
      currentN = null;
      currentValue = "";
    };
    for (const line of block[1]!.split("\n")) {
      const numeric = /^\s*\|\s*(\d+)\s*=(.*)$/.exec(line);
      if (numeric) {
        flush();
        currentN = Number(numeric[1]);
        currentValue = numeric[2]!;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        // A non-numeric param (boxstyle_N=, style=, ...) ends whatever
        // numeric param was accumulating.
        flush();
        continue;
      }
      // Continuation of the previous numeric param's (possibly multi-line) value.
      if (currentN !== null) currentValue += `\n${line}`;
    }
    flush();
  }
  const relations: { n: number; father?: number; mother?: number }[] = [];
  for (const n of nodes.keys()) {
    const hasFather = nodes.has(2 * n);
    const hasMother = nodes.has(2 * n + 1);
    if (!hasFather && !hasMother) continue;
    const rel: { n: number; father?: number; mother?: number } = { n };
    if (hasFather) rel.father = 2 * n;
    if (hasMother) rel.mother = 2 * n + 1;
    relations.push(rel);
  }
  return { nodes, relations };
}

// ---------------------------------------------------------------------------
// Pass 2: flat kinship-labelled lines — a small state machine.
// ---------------------------------------------------------------------------

type Role =
  | "father" | "mother"
  | "paternalGrandfather" | "paternalGrandmother"
  | "maternalGrandfather" | "maternalGrandmother"
  | "greatGrandUp" // 曾祖/外曾祖/高祖/外高祖 — chained onto whichever grandparent line precedes it
  | "spouse"
  | "child"
  | "grandchildOfLastChild"
  | "sibling";

const LABELS: { re: RegExp; role: Role }[] = [
  { re: /^(?:父親|父亲|父)$/, role: "father" },
  { re: /^(?:母親|母亲|母)$/, role: "mother" },
  { re: /^(?:祖父)$/, role: "paternalGrandfather" },
  { re: /^(?:祖母)$/, role: "paternalGrandmother" },
  { re: /^(?:外祖父|外公)$/, role: "maternalGrandfather" },
  { re: /^(?:外祖母|外婆)$/, role: "maternalGrandmother" },
  { re: /^(?:曾祖父|曾祖母|外曾祖父|外曾祖母|高祖父|高祖母|外高祖父|外高祖母)$/, role: "greatGrandUp" },
  { re: /^(?:妻|夫|配偶|原配|继室|繼室|继配|繼配|续弦|續弦)$/, role: "spouse" },
  { re: /^(?:子|女|长子|長子|次子|三子|长女|長女|次女|三女|子女|養子|养子|養女|养女)$/, role: "child" },
  { re: /^(?:孙|孫|孙女|孫女|外孙|外孫|外孙女|外孫女)$/, role: "grandchildOfLastChild" },
  { re: /^(?:兄|弟|姊|姐|妹|兄弟|姊妹|兄長|兄长)$/, role: "sibling" },
];

function matchLabel(label: string): Role | null {
  for (const l of LABELS) if (l.re.test(label)) return l.role;
  return null;
}

type FlatLine = { role: Role; names: RawName[] };

/**
 * Prose-style family sections (common when there is no Ahnentafel chart —
 * e.g. 胡適's "=== 父母 ===" / "=== 妻子 ===" / "=== 兒女 ===" subsections)
 * state the label immediately against the name with no colon and no space:
 * "父亲[[胡傳]]（1841年－...）" / "母亲冯顺弟，安徽省..." / "#长子[[胡祖望]]（...）".
 * Only the unambiguous-relative-to-root roles are worth guessing here —
 * grandparent labels need the colon form's context to disambiguate paternal
 * vs. maternal, so they are deliberately not included.
 */
const NOCOLON_LABELS: { prefix: string; role: Role }[] = [
  { prefix: "父親", role: "father" }, { prefix: "父亲", role: "father" },
  { prefix: "母親", role: "mother" }, { prefix: "母亲", role: "mother" },
  { prefix: "妻子", role: "spouse" }, { prefix: "丈夫", role: "spouse" }, { prefix: "配偶", role: "spouse" },
  { prefix: "長子", role: "child" }, { prefix: "长子", role: "child" },
  { prefix: "次子", role: "child" }, { prefix: "三子", role: "child" },
  { prefix: "長女", role: "child" }, { prefix: "长女", role: "child" },
  { prefix: "次女", role: "child" }, { prefix: "三女", role: "child" },
  { prefix: "兒子", role: "child" }, { prefix: "儿子", role: "child" },
  { prefix: "女兒", role: "child" }, { prefix: "女儿", role: "child" },
];

function parseNoColonLine(line: string): FlatLine | null {
  for (const { prefix, role } of NOCOLON_LABELS) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const link = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(rest);
    if (link) {
      const linkTitle = link[1]!.trim();
      const display = (link[2] ?? link[1]!).trim();
      return { role, names: [{ display, linkTitle }] };
    }
    // No wikilink (common for a non-notable mother/wife) — accept a short CJK
    // run only when it is cleanly followed by punctuation, so a sentence like
    // "父亲的家族史很复杂" (which is prose, not a name) does not misfire.
    const plain = /^([一-龥]{2,4})(?=[，,。、（(]|$)/.exec(rest);
    if (plain) return { role, names: [{ display: plain[1]! }] };
    return null;
  }
  return null;
}

function parseFlatLines(section: string): { lines: FlatLine[]; unparsedMentions: string[] } {
  const out: FlatLine[] = [];
  const unparsedMentions: string[] = [];
  for (const rawLine of section.split(/\n/)) {
    const line = rawLine.replace(/^[*#:\s]+/, "").trim();
    if (!line) continue;
    // "长女陈流求=董有松" — daughter, no colon, "=" links her to her husband.
    const daughterEq = /^(长女|長女|次女|三女|长子|長子|次子|三子)([^=＝]+)[=＝]\s*(.+)$/.exec(line);
    if (daughterEq) {
      const child = firstName(daughterEq[2]!);
      const spouse = firstName(daughterEq[3]!);
      if (child) out.push({ role: "child", names: [child] });
      if (child && spouse) out.push({ role: "spouse", names: [child, spouse] }); // handled specially below
      continue;
    }
    // "外孙女 董景同=刘仁勇" / "外孙 虞小盟" — grandchild, space not colon,
    // spouse after "=" optional.
    const grandchildSpace = /^(孙|孫|孙女|孫女|外孙|外孫|外孙女|外孫女)\s+([^=＝]+?)(?:[=＝]\s*(.+))?$/.exec(line);
    if (grandchildSpace) {
      const grandchild = firstName(grandchildSpace[2]!);
      const spouse = grandchildSpace[3] ? firstName(grandchildSpace[3]) : null;
      if (grandchild) out.push({ role: "grandchildOfLastChild", names: [grandchild] });
      if (grandchild && spouse) out.push({ role: "spouse", names: [grandchild, spouse] });
      continue;
    }
    const colon = /^([^:：]{1,6})[:：]\s*(.+)$/.exec(line);
    if (colon) {
      const role = matchLabel(colon[1]!.trim());
      const names = role ? splitNames(colon[2]!) : [];
      if (role && names.length > 0) {
        out.push({ role, names });
        continue;
      }
    }
    const noColon = parseNoColonLine(line);
    if (noColon) {
      out.push(noColon);
      continue;
    }
    // Nothing matched. If the line still names someone (a wikilink), surface
    // it for a human rather than silently dropping it — this is typically a
    // grandchild described in prose ("X，Y與Z之子。") that free-text parsing
    // cannot reliably resolve to a relation.
    if (/\[\[[^\]]+\]\]/.test(line)) unparsedMentions.push(line.slice(0, 160));
  }
  return { lines: out, unparsedMentions };
}

// ---------------------------------------------------------------------------
// Assemble: turn both passes into id-less relation triples keyed by RawName,
// then resolve every RawName to a QID (or a synthetic id) in one batch.
// ---------------------------------------------------------------------------

type Triple = { kind: "parent" | "spouse"; a: RawName; b: RawName; note: string };

function assemble(
  root: RawName,
  ahnentafel: ReturnType<typeof parseAhnentafel>,
  flat: FlatLine[],
): { triples: Triple[]; notes: string[] } {
  const triples: Triple[] = [];
  const notes: string[] = [];

  // Ahnentafel: father of N = 2N, mother of N = 2N+1. Node 1 is always root,
  // but only trust that when the chart actually agrees with root's own name —
  // otherwise this article's chart is about someone else quoted in passing.
  if (ahnentafel.nodes.size > 0) {
    const n1 = ahnentafel.nodes.get(1);
    const isRootChart = n1 && (n1.display === root.display || n1.linkTitle === root.linkTitle);
    if (isRootChart) {
      // A self-referencing article never wikilinks its own subject, so node 1
      // usually has no linkTitle — swap in the canonical `root` (which does
      // carry the article's own title) so every edge touching "node 1" ends up
      // on the same identity as the flat-line pass's root, instead of minting
      // a second synthetic id for the same person.
      ahnentafel.nodes.set(1, root);
      for (const rel of ahnentafel.relations) {
        const child = ahnentafel.nodes.get(rel.n)!;
        if (rel.father) triples.push({ kind: "parent", a: ahnentafel.nodes.get(rel.father)!, b: child, note: "ahnentafel" });
        if (rel.mother) triples.push({ kind: "parent", a: ahnentafel.nodes.get(rel.mother)!, b: child, note: "ahnentafel" });
      }
    } else {
      notes.push("发现 Ahnentafel 图表，但顶点姓名与条目主角不符，已跳过（可能是家族中另一人的图表）");
    }
  }

  // Flat lines, with running context so a grandchild attaches to the last
  // child mentioned, and a paternal/maternal great-grandparent chains onto
  // whichever grandparent line was last seen (single-line-family paragraph
  // style — see 陈寅恪 example).
  let lastChild: RawName | null = null;
  let lastGrandparent: RawName | null = null;
  let father: RawName | null = null;
  let mother: RawName | null = null;
  for (const line of flat) {
    switch (line.role) {
      case "father":
        father = line.names[0] ?? null;
        if (father) triples.push({ kind: "parent", a: father, b: root, note: "flat:父" });
        break;
      case "mother":
        mother = line.names[0] ?? null;
        if (mother) triples.push({ kind: "parent", a: mother, b: root, note: "flat:母" });
        break;
      case "paternalGrandfather":
      case "paternalGrandmother":
        if (father && line.names[0]) {
          triples.push({ kind: "parent", a: line.names[0], b: father, note: `flat:${line.role}` });
          lastGrandparent = line.names[0];
        } else {
          notes.push(`忽略「${line.role}」行——未先解析出父亲，无法确认这是父系还是母系`);
        }
        break;
      case "maternalGrandfather":
      case "maternalGrandmother":
        if (mother && line.names[0]) {
          triples.push({ kind: "parent", a: line.names[0], b: mother, note: `flat:${line.role}` });
          lastGrandparent = line.names[0];
        } else {
          notes.push(`忽略「${line.role}」行——未先解析出母亲，无法确认这是父系还是母系`);
        }
        break;
      case "greatGrandUp":
        if (lastGrandparent && line.names[0]) {
          triples.push({ kind: "parent", a: line.names[0], b: lastGrandparent, note: "flat:曾祖/高祖链（按行序推断，未核实是否单线）" });
          lastGrandparent = line.names[0];
        } else {
          notes.push("忽略一行曾祖/高祖——前面没有已解析的祖父母可挂靠，需人工核对");
        }
        break;
      case "spouse":
        if (line.names.length === 2) {
          // From the "X=Y" shorthand (daughter=husband, grandchild=spouse):
          // names[0]=the descendant, names[1]=their spouse.
          triples.push({ kind: "spouse", a: line.names[0]!, b: line.names[1]!, note: "flat:子女/孙辈=配偶简写" });
        } else {
          for (const n of line.names) triples.push({ kind: "spouse", a: root, b: n, note: "flat:配偶" });
        }
        break;
      case "child":
        for (const n of line.names) {
          triples.push({ kind: "parent", a: root, b: n, note: "flat:子女" });
          lastChild = n;
        }
        break;
      case "grandchildOfLastChild":
        if (lastChild) {
          for (const n of line.names) triples.push({ kind: "parent", a: lastChild, b: n, note: "flat:孙辈（挂靠在上一条子女行）" });
        } else {
          notes.push("忽略一行孙辈——前面没有已解析的子女可挂靠，需人工核对");
        }
        break;
      case "sibling":
        if (father) {
          for (const n of line.names) triples.push({ kind: "parent", a: father, b: n, note: "flat:兄弟姊妹（假设同父，未核实是否同母/是否异母异父）" });
        } else {
          notes.push(`忽略兄弟姊妹行（${line.names.map((n) => n.display).join("、")}）——未解析出父亲，无法挂靠`);
        }
        break;
    }
  }
  return { triples, notes };
}

// ---------------------------------------------------------------------------
// Resolve RawName -> QID (batched pageprops lookup on wikilink titles).
// ---------------------------------------------------------------------------

async function resolveQids(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(titles)];
  for (let i = 0; i < unique.length; i += 45) {
    const batch = unique.slice(i, i + 45);
    const json = await api<{
      query?: { pages?: { title: string; pageprops?: { wikibase_item?: string } }[] };
    }>(ZHWIKI_API, {
      action: "query",
      prop: "pageprops",
      ppprop: "wikibase_item",
      redirects: "1",
      titles: batch.join("|"),
      formatversion: "2",
    });
    for (const page of json.query?.pages ?? []) {
      if (page.pageprops?.wikibase_item) out.set(page.title, page.pageprops.wikibase_item);
    }
  }
  return out;
}

const nameKey = (n: RawName): string => n.linkTitle ?? n.display;

export type FetchZhwikiResult =
  | {
      status: "ok";
      outPath: string;
      title: string;
      peopleCount: number;
      resolvedCount: number;
      relationsCount: number;
      ahnentafelNodes: number;
      notesCount: number;
    }
  | { status: "no-section"; title: string }
  | { status: "redirect-loop-or-missing"; error: string };

/**
 * Fetches and extracts one article's family section, writing the review file.
 * Shared by the single-target CLI (`main` below) and the batch runner
 * (fetch-zhwiki-family-batch.ts) — batch mode is just this in a loop with a
 * candidate list and the shared module-level throttle doing the rate limiting.
 */
export async function fetchZhwikiFamily(target: string, key: string): Promise<FetchZhwikiResult> {
  const rootQid = /^Q\d+$/.test(target) ? target : null;
  let requestedTitle: string;
  try {
    requestedTitle = rootQid ? await titleFromQid(rootQid) : target;
  } catch (error) {
    return { status: "redirect-loop-or-missing", error: String(error) };
  }

  const { title, content: wikitext } = await fetchWikitext(requestedTitle);
  const sections = extractFamilySections(wikitext);
  if (sections.length === 0) {
    return { status: "no-section", title };
  }
  const section = sections.join("\n\n");

  const root: RawName = { display: toSimplified(title), linkTitle: title };
  const ahnentafel = parseAhnentafel(section);
  const flat = parseFlatLines(stripAhnentafelBlocks(section));
  const { triples, notes: assembleNotes } = assemble(root, ahnentafel, flat.lines);
  const notes = [
    ...assembleNotes,
    ...flat.unparsedMentions.map((line) => `未解析（需人工判断关系）：${line}`),
  ];

  // Collect every name that needs a QID lookup (root + everyone mentioned).
  const allNames = new Map<string, RawName>();
  allNames.set(nameKey(root), root);
  for (const t of triples) {
    allNames.set(nameKey(t.a), t.a);
    allNames.set(nameKey(t.b), t.b);
  }
  const linkTitles = [...allNames.values()].map((n) => n.linkTitle).filter((t): t is string => Boolean(t));
  const qidByTitle = rootQid
    ? new Map([[title, rootQid], ...(await resolveQids(linkTitles.filter((t) => t !== title)))])
    : await resolveQids(linkTitles);

  const idOf = (n: RawName): string => {
    const qid = n.linkTitle ? qidByTitle.get(n.linkTitle) : undefined;
    return qid ?? `zhwiki:${toSimplified(n.linkTitle ?? n.display)}`;
  };

  const people = new Map<string, { externalId: string; name: string; citation: string; resolved: boolean }>();
  for (const n of allNames.values()) {
    const externalId = idOf(n);
    if (!people.has(externalId)) {
      people.set(externalId, {
        externalId,
        name: toSimplified(n.display),
        citation: `中文维基百科《${title}》家庭章节`,
        resolved: externalId.startsWith("Q"),
      });
    }
  }

  const relations: SourceRelation[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const t of triples) {
    const a = idOf(t.a);
    const b = idOf(t.b);
    if (a === b) {
      dropped.push(`自环已丢弃（${t.a.display} = ${t.b.display}，来源：${t.note}）`);
      continue;
    }
    if (t.kind === "parent") {
      const k = `p:${a}>${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      relations.push({ kind: "parent", parent: a, child: b });
    } else {
      const [x, y] = a < b ? [a, b] : [b, a];
      const k = `s:${x}-${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      relations.push({ kind: "spouse", a: x, b: y });
    }
  }

  const unresolved = [...people.values()].filter((p) => !p.resolved).map((p) => `${p.externalId}\t${p.name}`);

  const review = {
    key,
    sourceTitle: title,
    fetchedAt: new Date().toISOString(),
    // Not a GenealogyDataset the importer will read — one extra field
    // (`resolved`) marks which people still need a human to check their id.
    namespace: "wikidata",
    people: [...people.values()],
    relations,
    ahnentafelPeopleFound: ahnentafel.nodes.size,
    unresolved,
    notes: [...notes, ...dropped],
  };

  const dir = join(process.cwd(), "modules", "genealogy", "import", "sources", "review");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${key}.zhwiki.review.json`);
  writeFileSync(out, JSON.stringify(review, null, 2) + "\n", "utf8");

  return {
    status: "ok",
    outPath: out,
    title,
    peopleCount: review.people.length,
    resolvedCount: review.people.length - unresolved.length,
    relationsCount: relations.length,
    ahnentafelNodes: ahnentafel.nodes.size,
    notesCount: review.notes.length,
  };
}

function formatResult(result: FetchZhwikiResult): string {
  if (result.status === "ok") {
    return (
      `wrote ${result.outPath}\n` +
      `  people=${result.peopleCount} (resolved=${result.resolvedCount}, unresolved=${result.peopleCount - result.resolvedCount})\n` +
      `  relations=${result.relationsCount} (ahnentafel nodes=${result.ahnentafelNodes})\n` +
      `  notes=${result.notesCount}${result.notesCount ? " — see file" : ""}\n`
    );
  }
  if (result.status === "no-section") {
    return `no 家庭/家世/家族 section found in 《${result.title}》 — nothing to extract.\n`;
  }
  return `fetch failed: ${result.error}\n`;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  const key = process.argv[3];
  if (!target || !key) {
    process.stderr.write("usage: fetch-zhwiki-family.ts <zhTitleOrQID> <key>\n");
    process.exitCode = 1;
    return;
  }
  const result = await fetchZhwikiFamily(target, key);
  process.stdout.write(formatResult(result));
  if (result.status !== "ok") process.exitCode = 1;
}

// Only run the CLI when this file is executed directly (`tsx
// fetch-zhwiki-family.ts ...`), not when fetch-zhwiki-family-batch.ts imports
// `fetchZhwikiFamily` from it.
const isMain = process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\/+/, "")}`;
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`fetch failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
