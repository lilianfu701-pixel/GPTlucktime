/**
 * Source-agnostic contracts for importing genealogy into the platform.
 *
 * A dataset is the shape every source normalizes to: a flat list of people,
 * each with a stable id within that source, plus a list of relations between
 * those ids. An adapter for Wikidata, CBDB, a 族谱 book or a hand-authored
 * fixture all produce the same {@link GenealogyDataset}; the importer downstream
 * neither knows nor cares which one it came from.
 *
 * The normalized shape is deliberately smaller than what a memorial can hold.
 * A source is trusted for identity and lineage — a name, rough dates, who a
 * person's parents and spouse were, and a citation for all of it — and nothing
 * more. Biography, media and the finer record are left for a claiming family to
 * add, so an import seeds a page without pretending to author a life.
 */

export type SourceGender = "male" | "female" | "unknown";

/** A date known to the precision the source actually has — often year only. */
export type SourceDate = {
  year: number;
  month?: number;
  day?: number;
};

export type SourcePlace = {
  country?: string;
  region?: string;
  city?: string;
};

export type SourcePerson = {
  /**
   * Stable identifier within the source (e.g. a Wikidata QID, a CBDB person id,
   * a row key in a 族谱). Used both to wire up relations and to derive the
   * per-person idempotency key, so re-importing the same source never
   * duplicates a page.
   */
  externalId: string;
  /** Primary name, in the source's own script (Chinese for a 族谱 or CBDB). */
  name: string;
  /** 字 / 号 / former names — recorded as searchable aliases. */
  aliases?: string[];
  gender?: SourceGender;
  birth?: SourceDate;
  death?: SourceDate;
  ancestralHometown?: string;
  birthPlace?: SourcePlace;
  deathPlace?: SourcePlace;
  /**
   * A human-readable citation for this record — where the fact came from. Kept
   * so an imported page can always answer "who says so", which is what keeps a
   * seeded graph trustworthy rather than a rumour at scale.
   */
  citation: string;
};

/**
 * A relation between two people, by their source ids.
 *
 * Only the two edges the family graph actually stores: a directed parent→child
 * tie, and a symmetric spouse tie. Siblings, grandparents, uncles and cousins
 * are never stated here — the kinship engine derives them from these two, so a
 * source cannot assert a sibling edge that contradicts the parents around it.
 */
export type SourceRelation =
  | { kind: "parent"; parent: string; child: string }
  | { kind: "spouse"; a: string; b: string };

export type GenealogyDataset = {
  /**
   * Stable key identifying the source, e.g. "wikidata" or
   * "fixture:song-su-family". Namespaces the idempotency keys so two sources
   * that happen to share an external id do not collide.
   */
  key: string;
  people: SourcePerson[];
  relations: SourceRelation[];
};

/**
 * A source of genealogy data. One implementation per origin (Wikidata, CBDB, a
 * 族谱 file, a fixture). `load` does whatever fetching/parsing that origin needs
 * and returns the normalized dataset; everything origin-specific stops here.
 */
export interface GenealogySource {
  readonly key: string;
  load(): Promise<GenealogyDataset>;
}
