import type { GenealogyDataset, GenealogySource } from "../types";
import soong from "./soong.data.json";
import chiang from "./chiang.data.json";
import luxun from "./luxun.data.json";
import rong from "./rong.data.json";
import qian from "./qian.data.json";
import mei from "./mei.data.json";
import bingxin from "./bingxin.data.json";
import yuan from "./yuan.data.json";
import zhangzuolin from "./zhangzuolin.data.json";
import liang from "./liang.data.json";
import lihongzhang from "./lihongzhang.data.json";
import zeng from "./zeng.data.json";
import puyi from "./puyi.data.json";

/**
 * Every Wikidata-sourced family in one registry, so wiring a new one is a single
 * import + row here rather than a bespoke loader file. All share the "wikidata"
 * identity namespace (see the datasets' `namespace`), so a person who appears in
 * two families — 蒋中正 in 宋家 and 蒋家, say — resolves to one page by QID
 * rather than a duplicate. Snapshots are produced by
 * `scripts/fetch-wikidata-family.ts` and committed for review; the import reads
 * them, so a seed never depends on Wikidata being reachable.
 *
 * Order is the curated presentation order for the admin panel.
 */
const FAMILIES: { key: string; label: string; dataset: GenealogyDataset }[] = [
  { key: "soong", label: "宋氏家族", dataset: soong as GenealogyDataset },
  { key: "chiang", label: "蒋氏家族", dataset: chiang as GenealogyDataset },
  { key: "luxun", label: "鲁迅（周氏）家族", dataset: luxun as GenealogyDataset },
  { key: "liang", label: "梁启超家族", dataset: liang as GenealogyDataset },
  { key: "lihongzhang", label: "李鸿章家族", dataset: lihongzhang as GenealogyDataset },
  { key: "zeng", label: "曾国藩家族", dataset: zeng as GenealogyDataset },
  { key: "yuan", label: "袁世凯家族", dataset: yuan as GenealogyDataset },
  { key: "zhangzuolin", label: "张作霖家族", dataset: zhangzuolin as GenealogyDataset },
  { key: "rong", label: "荣氏家族", dataset: rong as GenealogyDataset },
  { key: "qian", label: "钱氏（钱锺书）家族", dataset: qian as GenealogyDataset },
  { key: "mei", label: "梅兰芳家族", dataset: mei as GenealogyDataset },
  { key: "bingxin", label: "冰心（谢氏）家族", dataset: bingxin as GenealogyDataset },
  // 清皇室（溥仪）：完整世系，多为封号名，绝嗣线，人数最大——放在末尾。
  { key: "puyi", label: "清皇室（溥仪）", dataset: puyi as GenealogyDataset },
];

export type WikidataFamilyMeta = {
  key: string;
  label: string;
  people: number;
  photos: number;
};

/** Lightweight metadata for the admin panel — no dataset bodies. */
export const wikidataFamilyList: WikidataFamilyMeta[] = FAMILIES.map((f) => ({
  key: f.key,
  label: f.label,
  people: f.dataset.people.length,
  photos: f.dataset.people.filter((p) => p.photoUrl).length,
}));

const byKey = new Map(FAMILIES.map((f) => [f.key, f.dataset]));

/** A source for one family key, or undefined if the key is unknown. */
export function wikidataFamilySource(key: string): GenealogySource | undefined {
  const dataset = byKey.get(key);
  if (!dataset) return undefined;
  return { key: dataset.key, load: async () => dataset };
}

export const wikidataFamilyKeys: string[] = FAMILIES.map((f) => f.key);
