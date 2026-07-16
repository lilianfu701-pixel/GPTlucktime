import { EARTHLY_BRANCHES, type EarthlyBranch, type HeavenlyStem, type Pillar } from "../pillars/tables";

export const TWELVE_LIFE_STAGES = [
  "长生",
  "沐浴",
  "冠带",
  "临官",
  "帝旺",
  "衰",
  "病",
  "死",
  "墓",
  "绝",
  "胎",
  "养",
] as const;
export type TwelveLifeStage = (typeof TWELVE_LIFE_STAGES)[number];

const NAYIN_BY_DECADE = [
  "海中金", "炉中火", "大林木", "路旁土", "剑锋金", "山头火", "涧下水", "城头土", "白蜡金", "杨柳木",
  "泉中水", "屋上土", "霹雳火", "松柏木", "长流水", "砂中金", "山下火", "平地木", "壁上土", "金箔金",
  "覆灯火", "天河水", "大驿土", "钗钏金", "桑柘木", "大溪水", "沙中土", "天上火", "石榴木", "大海水",
] as const;
const XUN_KONG_BY_DECADE: readonly (readonly [EarthlyBranch, EarthlyBranch])[] = [
  ["戌", "亥"], ["申", "酉"], ["午", "未"], ["辰", "巳"], ["寅", "卯"], ["子", "丑"],
];
const LIFE_STAGES_BY_STEM: Readonly<Record<HeavenlyStem, readonly TwelveLifeStage[]>> = Object.freeze({
  甲: ["沐浴", "冠带", "临官", "帝旺", "衰", "病", "死", "墓", "绝", "胎", "养", "长生"],
  乙: ["病", "衰", "帝旺", "临官", "冠带", "沐浴", "长生", "养", "胎", "绝", "墓", "死"],
  丙: ["胎", "养", "长生", "沐浴", "冠带", "临官", "帝旺", "衰", "病", "死", "墓", "绝"],
  丁: ["绝", "墓", "死", "病", "衰", "帝旺", "临官", "冠带", "沐浴", "长生", "养", "胎"],
  戊: ["胎", "养", "长生", "沐浴", "冠带", "临官", "帝旺", "衰", "病", "死", "墓", "绝"],
  己: ["绝", "墓", "死", "病", "衰", "帝旺", "临官", "冠带", "沐浴", "长生", "养", "胎"],
  庚: ["死", "墓", "绝", "胎", "养", "长生", "沐浴", "冠带", "临官", "帝旺", "衰", "病"],
  辛: ["长生", "养", "胎", "绝", "墓", "死", "病", "衰", "帝旺", "临官", "冠带", "沐浴"],
  壬: ["帝旺", "衰", "病", "死", "墓", "绝", "胎", "养", "长生", "沐浴", "冠带", "临官"],
  癸: ["临官", "冠带", "沐浴", "长生", "养", "胎", "绝", "墓", "死", "病", "衰", "帝旺"],
});

export function nayinFor(pillar: Pillar): Readonly<{ ruleId: "aux.nayin.v1"; name: string }> {
  return Object.freeze({ ruleId: "aux.nayin.v1", name: NAYIN_BY_DECADE[Math.floor(pillar.index / 2)] });
}

export function xunKongFor(
  pillar: Pillar,
): Readonly<{ ruleId: "aux.xunkong.v1"; voidBranches: readonly EarthlyBranch[] }> {
  return Object.freeze({
    ruleId: "aux.xunkong.v1",
    voidBranches: Object.freeze([...XUN_KONG_BY_DECADE[Math.floor(pillar.index / 10)]]),
  });
}

/** Looks up a life-stage table entry only; it does not infer strength or favorability. */
export function twelveLifeStageFor(
  stem: HeavenlyStem,
  branch: EarthlyBranch,
): Readonly<{ ruleId: "aux.twelve-life-stage.v1"; stage: TwelveLifeStage }> {
  return Object.freeze({
    ruleId: "aux.twelve-life-stage.v1",
    stage: LIFE_STAGES_BY_STEM[stem][EARTHLY_BRANCHES.indexOf(branch)],
  });
}
