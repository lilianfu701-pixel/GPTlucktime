import type { GenealogyDataset, GenealogySource } from "../types";
import soong from "./soong.data.json";

/**
 * The Soong family (宋氏家族), snapshotted from Wikidata by
 * `scripts/fetch-wikidata-family.ts` into the committed `soong.data.json`.
 *
 * A real modern lineage with the whole shape a single 世家谱 line lacks: three
 * generations, collateral branches (the 倪 and 牛 families married in), the
 * three sisters' marriages into the 孙/蒋/孔 families, plus photos and short
 * biographies. The import reads the snapshot, so it never depends on Wikidata
 * being reachable and the data can be reviewed before it is seeded.
 */
const dataset = soong as GenealogyDataset;

export const soongFamilySource: GenealogySource = {
  key: dataset.key,
  load: async () => dataset,
};
