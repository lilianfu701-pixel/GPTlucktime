# Genealogy import sources

Where the seed data in this directory comes from, what counts as "good enough"
to import, and why CBDB collection stopped at 460 families instead of the
originally planned 1000.

## Source inventory

| Source | File(s) | What it is | Status |
|---|---|---|---|
| Wikidata | `wikidata-families.ts` (families before batch 37) | Notable-family kinship pulled from Wikidata's structured claims (P22/P25/P26/P40 etc.) | Active, ~150 hand-picked families |
| CBDB | `wikidata-families.ts` (batch 37–52), `*.data.json` | 中国历代人物传记资料库 — a biographical register, not a genealogy archive | **Paused** — see below |
| GEDCOM | `gedcom.ts` | Generic parser for the GEDCOM 5.5.1 standard | Format support, not a source itself |
| Named lineages | `kong-lineage.ts`, `song-su-family.ts` | Hand-curated single-family imports (孔子世家, 三苏世家) | Reference implementations |

## Why CBDB collection stopped

CBDB's `person.php` API returns kinship edges (F/M/S/D/W/H codes) for anyone
in the database, not just people from documented family lineages. Early
batches (37–44) seeded from well-known officials and got dense, multi-generation
families. Later batches (50+) walked CBDB person-ids sequentially and mostly
hit isolated entries — clerks, minor examination candidates, single mentions in
a local gazetteer — with 0–2 relatives each.

**The lesson:** CBDB id sequence order is not a proxy for "belongs to a
documented family." A person having a CBDB record means they were *mentioned*
in a historical text, not that their lineage was *recorded*. Treating id-range
scanning as a genealogy source produces a lot of degree-1 nodes: technically
real people, but not a family tree.

**460 families / 1,059 people were kept** (batches 37–49, all 0% name-overlap
with the existing corpus). Batches 50–52 (150 more families already written
and pushed) sit at the edge of this — future cleanup may prune the ones with
0–1 members. Batches beyond 52 were not started.

## Quality bar for a source to be worth importing

A source is **not** worth adapting into `SourcePerson`/`Relation` (see
`../importer.ts`) just because it has an API. It needs:

1. **The record itself claims lineage**, not just that two people are
   biographically linked. A 族谱/家谱 (clan genealogy register) says "these are
   the same family" as its reason for existing. A biographical dictionary says
   "this person existed" and kinship is incidental metadata.
2. **Multi-generation structure**, not isolated pairs. A family entry with 1–2
   members and no further edges available (checked via the same BFS the CBDB
   script uses) is a dead end — importing it just adds noise to the corpus
   without giving `kinship.ts` anything to derive from.
3. **A way to check overlap before writing.** Every existing script
   (`extract_cbdb_family.py`) dry-runs against `existing_names()` first. Any
   new source adapter must do the same — cross-source dedup does not happen
   automatically (see `project_missingu_cbdb_fetch` — CBDB namespace is
   deliberately separate from Wikidata QIDs, so a person imported from both
   sources will NOT auto-merge; only name-overlap at write time catches it).
4. **A license/attribution story.** Every person object carries a `citation`
   field pointing back to the source record. A source that can't be cited
   per-record (e.g. a paywalled archive with no stable identifiers) can't be
   imported this way even if the content is good.

## Candidate sources for the next phase (unresearched)

Raised by the user as a quality-over-quantity pivot after CBDB's sparse tail:

- **上海图书馆家谱馆 / 《中国家谱总目》** — ~52,000 家谱, 608 姓氏 catalogued.
  This is a *catalog*, not necessarily a machine-readable genealogy dataset —
  needs research into whether any of it is exposed as structured data (vs.
  physical/scanned volumes requiring OCR and manual transcription) before it
  can feed an importer the way CBDB or Wikidata do.
- **中华谱谍网 / other 族谱 aggregators** — unresearched, licensing unknown.
- **国家图书馆家谱数字化项目** — unresearched.

None of these have a `SourcePerson` adapter yet. Do not assume API
availability, license terms, or data structure until actually checked — CBDB
looked promising by the same logic (open JSON API, no auth) and still produced
a thin tail once the well-known-figure seed list ran out.

## Practical rule going forward

**Before writing an extraction script for a new source:** confirm by manual
sampling (5–10 records) that most entries have ≥3 members and ≥2 generations
of relations, *not* just that the API responds. A source that is 90% singleton
records is not a genealogy source no matter how large its catalog number is.
