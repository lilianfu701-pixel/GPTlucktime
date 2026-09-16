import type { GenealogyDataset, GenealogySource } from "../types";
import chiang from "./chiang.data.json";

/**
 * The Chiang family (蒋氏家族), snapshotted from Wikidata. Shares the "wikidata"
 * identity namespace with the Soong family, so people in both (蒋中正, 宋美龄)
 * resolve to one page rather than a duplicate.
 */
const dataset = chiang as GenealogyDataset;

export const chiangFamilySource: GenealogySource = {
  key: dataset.key,
  load: async () => dataset,
};
