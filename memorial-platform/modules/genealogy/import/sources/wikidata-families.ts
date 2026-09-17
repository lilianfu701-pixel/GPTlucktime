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
// Wave 2 — clans across more surnames and eras (ancient → modern).
import caocao from "./caocao.data.json";
import simaguang from "./simaguang.data.json";
import wangxizhi from "./wangxizhi.data.json";
import sushi from "./sushi.data.json";
import ouyangxiu from "./ouyangxiu.data.json";
import zhuxi from "./zhuxi.data.json";
import wangyangming from "./wangyangming.data.json";
import zhugeliang from "./zhugeliang.data.json";
import kongzi from "./kongzi.data.json";
import linzexu from "./linzexu.data.json";
import zuozongtang from "./zuozongtang.data.json";
import zhangzhidong from "./zhangzhidong.data.json";
import wengtonghe from "./wengtonghe.data.json";
import kangyouwei from "./kangyouwei.data.json";
import yanfu from "./yanfu.data.json";
import zhangtaiyan from "./zhangtaiyan.data.json";
import chenbaozhen from "./chenbaozhen.data.json";
import chenjiageng from "./chenjiageng.data.json";
import guomoruo from "./guomoruo.data.json";
import zhaoyuanren from "./zhaoyuanren.data.json";
// Wave 3 — more clans across the eras.
import mengzi from "./mengzi.data.json";
import simaqian from "./simaqian.data.json";
import banjia from "./banjia.data.json";
import caiyong from "./caiyong.data.json";
import xiean from "./xiean.data.json";
import taoyuanming from "./taoyuanming.data.json";
import yanzhenqing from "./yanzhenqing.data.json";
import liuzongyuan from "./liuzongyuan.data.json";
import hanyu from "./hanyu.data.json";
import fanzhongyan from "./fanzhongyan.data.json";
import wanganshi from "./wanganshi.data.json";
import yuefei from "./yuefei.data.json";
import wentianxiang from "./wentianxiang.data.json";
import luyou from "./luyou.data.json";
import zhaomengfu from "./zhaomengfu.data.json";
import zhangjuzheng from "./zhangjuzheng.data.json";
import huangzongxi from "./huangzongxi.data.json";
import guyanwu from "./guyanwu.data.json";
import zhengchenggong from "./zhengchenggong.data.json";
import jiyun from "./jiyun.data.json";
import yuanmei from "./yuanmei.data.json";
import tanyankai from "./tanyankai.data.json";
import huangxing from "./huangxing.data.json";
import liaozhongkai from "./liaozhongkai.data.json";
import xubeihong from "./xubeihong.data.json";

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
  // 第二批：跨姓氏、跨年代的名门望族（古代 → 近现代）。
  { key: "kongzi", label: "孔子家族（直系）", dataset: kongzi as GenealogyDataset },
  { key: "zhugeliang", label: "诸葛亮家族", dataset: zhugeliang as GenealogyDataset },
  { key: "caocao", label: "曹操家族（曹魏宗室）", dataset: caocao as GenealogyDataset },
  { key: "wangxizhi", label: "王羲之家族（琅琊王氏）", dataset: wangxizhi as GenealogyDataset },
  { key: "ouyangxiu", label: "欧阳修家族", dataset: ouyangxiu as GenealogyDataset },
  { key: "simaguang", label: "司马光家族", dataset: simaguang as GenealogyDataset },
  { key: "sushi", label: "苏轼家族（眉山苏氏）", dataset: sushi as GenealogyDataset },
  { key: "zhuxi", label: "朱熹家族", dataset: zhuxi as GenealogyDataset },
  { key: "wangyangming", label: "王阳明家族（余姚王氏）", dataset: wangyangming as GenealogyDataset },
  { key: "linzexu", label: "林则徐家族", dataset: linzexu as GenealogyDataset },
  { key: "zuozongtang", label: "左宗棠家族", dataset: zuozongtang as GenealogyDataset },
  { key: "zhangzhidong", label: "张之洞家族", dataset: zhangzhidong as GenealogyDataset },
  { key: "wengtonghe", label: "翁同龢家族（常熟翁氏）", dataset: wengtonghe as GenealogyDataset },
  { key: "kangyouwei", label: "康有为家族", dataset: kangyouwei as GenealogyDataset },
  { key: "yanfu", label: "严复家族", dataset: yanfu as GenealogyDataset },
  { key: "zhangtaiyan", label: "章太炎家族", dataset: zhangtaiyan as GenealogyDataset },
  { key: "chenbaozhen", label: "陈宝箴家族（义宁陈氏）", dataset: chenbaozhen as GenealogyDataset },
  { key: "chenjiageng", label: "陈嘉庚家族", dataset: chenjiageng as GenealogyDataset },
  { key: "guomoruo", label: "郭沫若家族", dataset: guomoruo as GenealogyDataset },
  { key: "zhaoyuanren", label: "赵元任家族（常州赵氏）", dataset: zhaoyuanren as GenealogyDataset },
  // 第三批：更多姓氏、更多年代的名门（先秦 → 现代）。
  { key: "mengzi", label: "孟子家族（孟氏）", dataset: mengzi as GenealogyDataset },
  { key: "simaqian", label: "司马迁家族", dataset: simaqian as GenealogyDataset },
  { key: "banjia", label: "班固家族（班氏）", dataset: banjia as GenealogyDataset },
  { key: "caiyong", label: "蔡邕家族（蔡文姬）", dataset: caiyong as GenealogyDataset },
  { key: "xiean", label: "谢安家族（陈郡谢氏）", dataset: xiean as GenealogyDataset },
  { key: "taoyuanming", label: "陶渊明家族（浔阳陶氏）", dataset: taoyuanming as GenealogyDataset },
  { key: "yanzhenqing", label: "颜真卿家族（琅琊颜氏）", dataset: yanzhenqing as GenealogyDataset },
  { key: "liuzongyuan", label: "柳宗元家族（河东柳氏）", dataset: liuzongyuan as GenealogyDataset },
  { key: "hanyu", label: "韩愈家族", dataset: hanyu as GenealogyDataset },
  { key: "fanzhongyan", label: "范仲淹家族", dataset: fanzhongyan as GenealogyDataset },
  { key: "wanganshi", label: "王安石家族（临川王氏）", dataset: wanganshi as GenealogyDataset },
  { key: "yuefei", label: "岳飞家族", dataset: yuefei as GenealogyDataset },
  { key: "wentianxiang", label: "文天祥家族", dataset: wentianxiang as GenealogyDataset },
  { key: "luyou", label: "陆游家族（山阴陆氏）", dataset: luyou as GenealogyDataset },
  { key: "zhaomengfu", label: "赵孟頫家族", dataset: zhaomengfu as GenealogyDataset },
  { key: "zhangjuzheng", label: "张居正家族", dataset: zhangjuzheng as GenealogyDataset },
  { key: "huangzongxi", label: "黄宗羲家族（余姚黄氏）", dataset: huangzongxi as GenealogyDataset },
  { key: "guyanwu", label: "顾炎武家族", dataset: guyanwu as GenealogyDataset },
  { key: "zhengchenggong", label: "郑成功家族（郑氏）", dataset: zhengchenggong as GenealogyDataset },
  { key: "jiyun", label: "纪昀家族（纪晓岚）", dataset: jiyun as GenealogyDataset },
  { key: "yuanmei", label: "袁枚家族", dataset: yuanmei as GenealogyDataset },
  { key: "tanyankai", label: "谭延闿家族", dataset: tanyankai as GenealogyDataset },
  { key: "huangxing", label: "黄兴家族", dataset: huangxing as GenealogyDataset },
  { key: "liaozhongkai", label: "廖仲恺家族（何香凝）", dataset: liaozhongkai as GenealogyDataset },
  { key: "xubeihong", label: "徐悲鸿家族", dataset: xubeihong as GenealogyDataset },
  // 清皇室（溥仪）：完整世系，多为封号名，绝嗣线，人数最大——放在末尾。
  { key: "puyi", label: "清皇室（溥仪）", dataset: puyi as GenealogyDataset },
];

export type WikidataFamilyMeta = {
  key: string;
  label: string;
  people: number;
  /** Deceased people — the ones that become seeded pages (living are masked
   * graph nodes, not memorials), so "已导入 N/deceased" can reach its total. */
  deceased: number;
  photos: number;
};

/** Lightweight metadata for the admin panel — no dataset bodies. */
export const wikidataFamilyList: WikidataFamilyMeta[] = FAMILIES.map((f) => ({
  key: f.key,
  label: f.label,
  people: f.dataset.people.length,
  deceased: f.dataset.people.filter((p) => !p.living).length,
  photos: f.dataset.people.filter((p) => p.photoUrl).length,
}));

/**
 * How many deceased people of each family already have a seeded memorial, given
 * the set of imported external ids (from `importedWikidataExternalIds`). Lets
 * the admin panel show real progress per family on load.
 */
export function wikidataImportedCounts(
  importedIds: Set<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FAMILIES) {
    out[f.key] = f.dataset.people.filter(
      (p) => !p.living && importedIds.has(p.externalId),
    ).length;
  }
  return out;
}

const byKey = new Map(FAMILIES.map((f) => [f.key, f.dataset]));

/** A source for one family key, or undefined if the key is unknown. */
export function wikidataFamilySource(key: string): GenealogySource | undefined {
  const dataset = byKey.get(key);
  if (!dataset) return undefined;
  return { key: dataset.key, load: async () => dataset };
}

export const wikidataFamilyKeys: string[] = FAMILIES.map((f) => f.key);
