import {
  type EarthlyBranch,
  type HeavenlyStem,
  type Pillar,
} from "../pillars/tables";

export const PILLAR_POSITIONS = ["year", "month", "day", "hour"] as const;
export type PillarPosition = (typeof PILLAR_POSITIONS)[number];
export type FourPillars = Readonly<Record<PillarPosition, Pillar>>;

export type RelationType =
  | "stem-combine"
  | "stem-clash"
  | "branch-combine"
  | "branch-clash"
  | "branch-harm"
  | "branch-break"
  | "branch-punishment"
  | "branch-triad"
  | "branch-meeting";

export interface RelationRecord {
  readonly ruleId: string;
  readonly type: RelationType;
  readonly participants: readonly string[];
  readonly pillarPositions: readonly PillarPosition[];
}

interface PairRule<T extends string> {
  readonly ruleId: string;
  readonly type: RelationType;
  readonly participants: readonly [T, T];
}

interface TripleRule {
  readonly ruleId: string;
  readonly type: "branch-punishment" | "branch-triad" | "branch-meeting";
  readonly participants: readonly [EarthlyBranch, EarthlyBranch, EarthlyBranch];
}

const STEM_COMBINES: readonly PairRule<HeavenlyStem>[] = [
  { ruleId: "stem.combine.jia-ji.v1", type: "stem-combine", participants: ["甲", "己"] },
  { ruleId: "stem.combine.yi-geng.v1", type: "stem-combine", participants: ["乙", "庚"] },
  { ruleId: "stem.combine.bing-xin.v1", type: "stem-combine", participants: ["丙", "辛"] },
  { ruleId: "stem.combine.ding-ren.v1", type: "stem-combine", participants: ["丁", "壬"] },
  { ruleId: "stem.combine.wu-gui.v1", type: "stem-combine", participants: ["戊", "癸"] },
];
const STEM_CLASHES: readonly PairRule<HeavenlyStem>[] = [
  { ruleId: "stem.clash.jia-geng.v1", type: "stem-clash", participants: ["甲", "庚"] },
  { ruleId: "stem.clash.yi-xin.v1", type: "stem-clash", participants: ["乙", "辛"] },
  { ruleId: "stem.clash.bing-ren.v1", type: "stem-clash", participants: ["丙", "壬"] },
  { ruleId: "stem.clash.ding-gui.v1", type: "stem-clash", participants: ["丁", "癸"] },
];
const BRANCH_COMBINES: readonly PairRule<EarthlyBranch>[] = [
  { ruleId: "branch.combine.zi-chou.v1", type: "branch-combine", participants: ["子", "丑"] },
  { ruleId: "branch.combine.yin-hai.v1", type: "branch-combine", participants: ["寅", "亥"] },
  { ruleId: "branch.combine.mao-xu.v1", type: "branch-combine", participants: ["卯", "戌"] },
  { ruleId: "branch.combine.chen-you.v1", type: "branch-combine", participants: ["辰", "酉"] },
  { ruleId: "branch.combine.si-shen.v1", type: "branch-combine", participants: ["巳", "申"] },
  { ruleId: "branch.combine.wu-wei.v1", type: "branch-combine", participants: ["午", "未"] },
];
const BRANCH_CLASHES: readonly PairRule<EarthlyBranch>[] = [
  { ruleId: "branch.clash.zi-wu.v1", type: "branch-clash", participants: ["子", "午"] },
  { ruleId: "branch.clash.chou-wei.v1", type: "branch-clash", participants: ["丑", "未"] },
  { ruleId: "branch.clash.yin-shen.v1", type: "branch-clash", participants: ["寅", "申"] },
  { ruleId: "branch.clash.mao-you.v1", type: "branch-clash", participants: ["卯", "酉"] },
  { ruleId: "branch.clash.chen-xu.v1", type: "branch-clash", participants: ["辰", "戌"] },
  { ruleId: "branch.clash.si-hai.v1", type: "branch-clash", participants: ["巳", "亥"] },
];
const BRANCH_HARMS: readonly PairRule<EarthlyBranch>[] = [
  { ruleId: "branch.harm.zi-wei.v1", type: "branch-harm", participants: ["子", "未"] },
  { ruleId: "branch.harm.chou-wu.v1", type: "branch-harm", participants: ["丑", "午"] },
  { ruleId: "branch.harm.yin-si.v1", type: "branch-harm", participants: ["寅", "巳"] },
  { ruleId: "branch.harm.mao-chen.v1", type: "branch-harm", participants: ["卯", "辰"] },
  { ruleId: "branch.harm.shen-hai.v1", type: "branch-harm", participants: ["申", "亥"] },
  { ruleId: "branch.harm.you-xu.v1", type: "branch-harm", participants: ["酉", "戌"] },
];
const BRANCH_BREAKS: readonly PairRule<EarthlyBranch>[] = [
  { ruleId: "branch.break.zi-you.v1", type: "branch-break", participants: ["子", "酉"] },
  { ruleId: "branch.break.mao-wu.v1", type: "branch-break", participants: ["卯", "午"] },
  { ruleId: "branch.break.chen-chou.v1", type: "branch-break", participants: ["辰", "丑"] },
  { ruleId: "branch.break.wei-xu.v1", type: "branch-break", participants: ["未", "戌"] },
  { ruleId: "branch.break.yin-hai.v1", type: "branch-break", participants: ["寅", "亥"] },
  { ruleId: "branch.break.si-shen.v1", type: "branch-break", participants: ["巳", "申"] },
];
const BRANCH_TRIADS: readonly TripleRule[] = [
  { ruleId: "branch.triad.shen-zi-chen.v1", type: "branch-triad", participants: ["申", "子", "辰"] },
  { ruleId: "branch.triad.hai-mao-wei.v1", type: "branch-triad", participants: ["亥", "卯", "未"] },
  { ruleId: "branch.triad.yin-wu-xu.v1", type: "branch-triad", participants: ["寅", "午", "戌"] },
  { ruleId: "branch.triad.si-you-chou.v1", type: "branch-triad", participants: ["巳", "酉", "丑"] },
];
const BRANCH_MEETINGS: readonly TripleRule[] = [
  { ruleId: "branch.meeting.hai-zi-chou.v1", type: "branch-meeting", participants: ["亥", "子", "丑"] },
  { ruleId: "branch.meeting.yin-mao-chen.v1", type: "branch-meeting", participants: ["寅", "卯", "辰"] },
  { ruleId: "branch.meeting.si-wu-wei.v1", type: "branch-meeting", participants: ["巳", "午", "未"] },
  { ruleId: "branch.meeting.shen-you-xu.v1", type: "branch-meeting", participants: ["申", "酉", "戌"] },
];
const BRANCH_PUNISHMENTS: readonly TripleRule[] = [
  { ruleId: "branch.punishment.yin-si-shen.v1", type: "branch-punishment", participants: ["寅", "巳", "申"] },
  { ruleId: "branch.punishment.chou-wei-xu.v1", type: "branch-punishment", participants: ["丑", "未", "戌"] },
];
const BRANCH_PAIR_PUNISHMENTS: readonly PairRule<EarthlyBranch>[] = [
  { ruleId: "branch.punishment.zi-mao.v1", type: "branch-punishment", participants: ["子", "卯"] },
];
const SELF_PUNISHING_BRANCHES: readonly EarthlyBranch[] = ["辰", "午", "酉", "亥"];

function frozenRecord(
  ruleId: string,
  type: RelationType,
  participants: readonly string[],
  pillarPositions: readonly PillarPosition[],
): RelationRecord {
  return Object.freeze({
    ruleId,
    type,
    participants: Object.freeze([...participants]),
    pillarPositions: Object.freeze([...pillarPositions]),
  });
}

function addPairRelations<T extends HeavenlyStem | EarthlyBranch>(
  records: RelationRecord[],
  values: readonly (readonly [PillarPosition, T])[],
  rules: readonly PairRule<T>[],
): void {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const pair = [values[left][1], values[right][1]];
      const rule = rules.find(
        (candidate) =>
          candidate.participants.includes(pair[0]) && candidate.participants.includes(pair[1]),
      );
      if (!rule) continue;

      const positions = rule.participants.map((participant) =>
        pair[0] === participant ? values[left][0] : values[right][0],
      );
      records.push(frozenRecord(rule.ruleId, rule.type, rule.participants, positions));
    }
  }
}

function addTripleRelations(
  records: RelationRecord[],
  values: readonly (readonly [PillarPosition, EarthlyBranch])[],
  rules: readonly TripleRule[],
): void {
  for (const rule of rules) {
    const positions = rule.participants.map((participant) =>
      values.find(([, branch]) => branch === participant)?.[0],
    );
    if (positions.every((position): position is PillarPosition => position !== undefined)) {
      records.push(frozenRecord(rule.ruleId, rule.type, rule.participants, positions));
    }
  }
}

/** Records only the traditional stem/branch relations present in the four pillars. */
export function deriveRelations(pillars: FourPillars): readonly RelationRecord[] {
  const stems = PILLAR_POSITIONS.map((position) => [position, pillars[position].stem] as const);
  const branches = PILLAR_POSITIONS.map((position) => [position, pillars[position].branch] as const);
  const records: RelationRecord[] = [];

  addPairRelations(records, stems, STEM_COMBINES);
  addPairRelations(records, stems, STEM_CLASHES);
  addPairRelations(records, branches, BRANCH_COMBINES);
  addPairRelations(records, branches, BRANCH_CLASHES);
  addPairRelations(records, branches, BRANCH_HARMS);
  addPairRelations(records, branches, BRANCH_BREAKS);
  addPairRelations(records, branches, BRANCH_PAIR_PUNISHMENTS);
  addTripleRelations(records, branches, BRANCH_TRIADS);
  addTripleRelations(records, branches, BRANCH_MEETINGS);
  addTripleRelations(records, branches, BRANCH_PUNISHMENTS);

  for (const branch of SELF_PUNISHING_BRANCHES) {
    const positions = branches.filter(([, value]) => value === branch).map(([position]) => position);
    if (positions.length > 1) {
      records.push(
        frozenRecord(
          `branch.punishment.self-${branch}.v1`,
          "branch-punishment",
          [branch, branch],
          positions.slice(0, 2),
        ),
      );
    }
  }

  return Object.freeze(records);
}
