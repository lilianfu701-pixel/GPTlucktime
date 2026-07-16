export const HEAVENLY_STEMS = Object.freeze([
  "甲",
  "乙",
  "丙",
  "丁",
  "戊",
  "己",
  "庚",
  "辛",
  "壬",
  "癸",
] as const);

export const EARTHLY_BRANCHES = Object.freeze([
  "子",
  "丑",
  "寅",
  "卯",
  "辰",
  "巳",
  "午",
  "未",
  "申",
  "酉",
  "戌",
  "亥",
] as const);

export type HeavenlyStem = (typeof HEAVENLY_STEMS)[number];
export type EarthlyBranch = (typeof EARTHLY_BRANCHES)[number];

export interface Pillar {
  readonly stem: HeavenlyStem;
  readonly branch: EarthlyBranch;
  readonly index: number;
}

export const SIXTY_JIA_ZI: readonly Pillar[] = Object.freeze(
  Array.from({ length: 60 }, (_, index) =>
    Object.freeze({
      stem: HEAVENLY_STEMS[index % HEAVENLY_STEMS.length],
      branch: EARTHLY_BRANCHES[index % EARTHLY_BRANCHES.length],
      index,
    }),
  ),
);

export const JIE_TERMS = Object.freeze([
  "lichun",
  "jingzhe",
  "qingming",
  "lixia",
  "mangzhong",
  "xiaoshu",
  "liqiu",
  "bailu",
  "hanlu",
  "lidong",
  "daxue",
  "xiaohan",
] as const);

export const HIDDEN_STEMS_BY_BRANCH: Readonly<
  Record<EarthlyBranch, readonly HeavenlyStem[]>
> = Object.freeze({
  子: Object.freeze(["癸"] as const),
  丑: Object.freeze(["己", "癸", "辛"] as const),
  寅: Object.freeze(["甲", "丙", "戊"] as const),
  卯: Object.freeze(["乙"] as const),
  辰: Object.freeze(["戊", "乙", "癸"] as const),
  巳: Object.freeze(["丙", "戊", "庚"] as const),
  午: Object.freeze(["丁", "己"] as const),
  未: Object.freeze(["己", "丁", "乙"] as const),
  申: Object.freeze(["庚", "壬", "戊"] as const),
  酉: Object.freeze(["辛"] as const),
  戌: Object.freeze(["戊", "辛", "丁"] as const),
  亥: Object.freeze(["壬", "甲"] as const),
} as const);
