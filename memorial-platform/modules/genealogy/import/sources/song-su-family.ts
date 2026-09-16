import type { GenealogyDataset, GenealogySource } from "../types";

/**
 * A small, license-clean fixture: the Song-dynasty Su family of Meishan (三苏).
 *
 * Every figure is a public-domain historical person documented in the 《宋史》,
 * all born well after year 1000, and the set is chosen to exercise the whole
 * chain rather than just a straight line — three generations plus siblings and a
 * spouse, so the kinship engine can derive relationships the data never states:
 * 苏轼 and 苏辙 as brothers (shared father), 苏辙 as the children's 叔父, 苏序 as
 * their 曾祖父, 王弗 as 苏迈's mother. It stands in for a real adapter (Wikidata,
 * CBDB, a 族谱 file) while the pipeline is proven end to end.
 */
const DATASET: GenealogyDataset = {
  key: "fixture:song-su-family",
  people: [
    {
      externalId: "su-xu",
      name: "苏序",
      aliases: ["仲先"],
      gender: "male",
      birth: { year: 973 },
      death: { year: 1047 },
      ancestralHometown: "眉州眉山",
      citation: "《宋史》/维基百科（示例数据）",
    },
    {
      externalId: "su-xun",
      name: "苏洵",
      aliases: ["明允", "老泉"],
      gender: "male",
      birth: { year: 1009 },
      death: { year: 1066 },
      ancestralHometown: "眉州眉山",
      citation: "《宋史·苏洵传》/维基百科（示例数据）",
    },
    {
      externalId: "su-shi",
      name: "苏轼",
      aliases: ["子瞻", "东坡居士"],
      gender: "male",
      birth: { year: 1037, month: 1, day: 8 },
      death: { year: 1101, month: 8, day: 24 },
      ancestralHometown: "眉州眉山",
      citation: "《宋史·苏轼传》/维基百科（示例数据）",
    },
    {
      externalId: "su-zhe",
      name: "苏辙",
      aliases: ["子由", "颍滨遗老"],
      gender: "male",
      birth: { year: 1039 },
      death: { year: 1112 },
      ancestralHometown: "眉州眉山",
      citation: "《宋史·苏辙传》/维基百科（示例数据）",
    },
    {
      externalId: "wang-fu",
      name: "王弗",
      gender: "female",
      birth: { year: 1039 },
      death: { year: 1065 },
      ancestralHometown: "眉州青神",
      citation: "维基百科（示例数据）",
    },
    {
      externalId: "su-mai",
      name: "苏迈",
      aliases: ["维康"],
      gender: "male",
      birth: { year: 1059 },
      death: { year: 1119 },
      ancestralHometown: "眉州眉山",
      citation: "维基百科（示例数据）",
    },
    {
      externalId: "su-dai",
      name: "苏迨",
      gender: "male",
      birth: { year: 1070 },
      death: { year: 1126 },
      ancestralHometown: "眉州眉山",
      citation: "维基百科（示例数据）",
    },
    {
      externalId: "su-guo",
      name: "苏过",
      aliases: ["叔党", "斜川居士"],
      gender: "male",
      birth: { year: 1072 },
      death: { year: 1123 },
      ancestralHometown: "眉州眉山",
      citation: "维基百科（示例数据）",
    },
  ],
  relations: [
    { kind: "parent", parent: "su-xu", child: "su-xun" },
    { kind: "parent", parent: "su-xun", child: "su-shi" },
    { kind: "parent", parent: "su-xun", child: "su-zhe" },
    { kind: "spouse", a: "su-shi", b: "wang-fu" },
    { kind: "parent", parent: "su-shi", child: "su-mai" },
    { kind: "parent", parent: "wang-fu", child: "su-mai" },
    { kind: "parent", parent: "su-shi", child: "su-dai" },
    { kind: "parent", parent: "su-shi", child: "su-guo" },
  ],
};

export const songSuFamilySource: GenealogySource = {
  key: DATASET.key,
  load: async () => DATASET,
};
