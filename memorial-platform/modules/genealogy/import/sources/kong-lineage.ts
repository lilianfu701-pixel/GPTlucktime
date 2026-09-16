import type { GenealogyDataset, GenealogySource } from "../types";

/**
 * First real batch: the direct 衍圣公 line of the Kong (Confucius) lineage.
 *
 * The Kong clan is the archetypal Chinese 族谱 and — uniquely — carries a single
 * nationwide generation poem (字辈): "……興毓傳繼廣昭憲慶繁祥令德維垂佑……". Every
 * Kong's given name embeds their generation's character, so an ordinary 孔-surname
 * user can place themselves against this line by their own 字辈 alone. That is the
 * point of seeding it: not the fame of these particular dukes, but that it gives
 * real descendants something to connect to — exactly what goal (2) needs.
 *
 * Only historical, deceased generations are seeded here (74th–78th, 繁→祥→令→德→
 * 維). The living 79th holder (孔垂長, b. 1975) is deliberately left out: living
 * people are handled by the masking + claim flow, not seeded as public pages.
 *
 * The chain up to 孔子 himself (1st generation, 6th c. BCE) is intentionally not
 * hand-authored — the intermediate generations must come from a sourced 族谱 via
 * the GEDCOM adapter, not from memory, so the pool is never seeded with a guess.
 */
const DATASET: GenealogyDataset = {
  key: "fixture:kong-lineage",
  people: [
    {
      externalId: "kong-fanhao",
      name: "孔繁灏",
      gender: "male",
      birth: { year: 1806 },
      death: { year: 1862 },
      ancestralHometown: "山东曲阜",
      generationName: "繁",
      citation: "《孔子世家谱》/维基百科（示例数据，第74代衍圣公，繁字辈）",
    },
    {
      externalId: "kong-xiangke",
      name: "孔祥珂",
      gender: "male",
      birth: { year: 1848 },
      death: { year: 1876 },
      ancestralHometown: "山东曲阜",
      generationName: "祥",
      citation: "《孔子世家谱》/维基百科（示例数据，第75代衍圣公，祥字辈）",
    },
    {
      externalId: "kong-lingyi",
      name: "孔令贻",
      aliases: ["燕庭"],
      gender: "male",
      birth: { year: 1872 },
      death: { year: 1919, month: 11, day: 8 },
      ancestralHometown: "山东曲阜",
      generationName: "令",
      citation: "《孔子世家谱》/维基百科（示例数据，第76代衍圣公，令字辈）",
    },
    {
      externalId: "kong-decheng",
      name: "孔德成",
      aliases: ["玉汝", "达生"],
      gender: "male",
      birth: { year: 1920, month: 2, day: 23 },
      death: { year: 2008, month: 10, day: 28 },
      ancestralHometown: "山东曲阜",
      generationName: "德",
      citation:
        "《孔子世家谱》/维基百科（示例数据，第77代衍圣公·末代，首任大成至圣先师奉祀官，德字辈）",
    },
    {
      externalId: "kong-weiyi",
      name: "孔维益",
      gender: "male",
      birth: { year: 1939 },
      death: { year: 1989 },
      ancestralHometown: "山东曲阜",
      generationName: "维",
      citation: "《孔子世家谱》/维基百科（示例数据，第78代，维字辈）",
    },
    {
      // Living — seeded as a masked node (孔**), not a page. The demo of both
      // "在世脱敏" and the register→claim flow: a real 孔-surname user of the 垂
      // generation could recognise and claim this spot.
      externalId: "kong-chuichang",
      name: "孔垂长",
      gender: "male",
      birth: { year: 1975 },
      ancestralHometown: "山东曲阜",
      generationName: "垂",
      living: true,
      citation: "维基百科（示例数据，第79代嫡长孙·大成至圣先师奉祀官，垂字辈，在世）",
    },
  ],
  relations: [
    { kind: "parent", parent: "kong-fanhao", child: "kong-xiangke" },
    { kind: "parent", parent: "kong-xiangke", child: "kong-lingyi" },
    { kind: "parent", parent: "kong-lingyi", child: "kong-decheng" },
    { kind: "parent", parent: "kong-decheng", child: "kong-weiyi" },
    { kind: "parent", parent: "kong-weiyi", child: "kong-chuichang" },
  ],
};

export const kongLineageSource: GenealogySource = {
  key: DATASET.key,
  load: async () => DATASET,
};
