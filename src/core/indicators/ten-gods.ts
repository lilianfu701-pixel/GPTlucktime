import { HIDDEN_STEMS_BY_BRANCH, type HeavenlyStem } from "../pillars/tables";
import { elementForStem, type Element } from "./elements";
import type { FourPillars, PillarPosition } from "./relations";

export const TEN_GODS = Object.freeze([
  "比肩",
  "劫财",
  "食神",
  "伤官",
  "偏财",
  "正财",
  "七杀",
  "正官",
  "偏印",
  "正印",
] as const);
export type TenGod = (typeof TEN_GODS)[number];

export interface TenGodRecord {
  readonly source: "visible" | "hidden";
  readonly pillarPosition: PillarPosition;
  readonly stem: HeavenlyStem;
  readonly tenGod: TenGod;
}

export interface TenGodFacts {
  readonly visible: readonly TenGodRecord[];
  readonly hidden: readonly TenGodRecord[];
}

const YANG_STEMS = new Set<HeavenlyStem>(["甲", "丙", "戊", "庚", "壬"]);
const PRODUCES: Readonly<Record<Element, Element>> = Object.freeze({
  wood: "fire",
  fire: "earth",
  earth: "metal",
  metal: "water",
  water: "wood",
});
const CONTROLS: Readonly<Record<Element, Element>> = Object.freeze({
  wood: "earth",
  fire: "metal",
  earth: "water",
  metal: "wood",
  water: "fire",
});

function samePolarity(left: HeavenlyStem, right: HeavenlyStem): boolean {
  return YANG_STEMS.has(left) === YANG_STEMS.has(right);
}

/** Returns the target stem's ten god relative to the day master. */
export function tenGodFor(dayMaster: HeavenlyStem, target: HeavenlyStem): TenGod {
  const selfElement = elementForStem(dayMaster);
  const targetElement = elementForStem(target);
  const same = samePolarity(dayMaster, target);

  if (targetElement === selfElement) return same ? "比肩" : "劫财";
  if (targetElement === PRODUCES[selfElement]) return same ? "食神" : "伤官";
  if (targetElement === CONTROLS[selfElement]) return same ? "偏财" : "正财";
  if (selfElement === CONTROLS[targetElement]) return same ? "七杀" : "正官";
  return same ? "偏印" : "正印";
}

function record(
  source: TenGodRecord["source"],
  pillarPosition: PillarPosition,
  dayMaster: HeavenlyStem,
  stem: HeavenlyStem,
): TenGodRecord {
  return Object.freeze({ source, pillarPosition, stem, tenGod: tenGodFor(dayMaster, stem) });
}

/** Derives visible and branch-hidden ten gods without assigning any interpretation. */
export function deriveTenGods(dayMaster: HeavenlyStem, pillars: FourPillars): TenGodFacts {
  const visible: TenGodRecord[] = [];
  const hidden: TenGodRecord[] = [];

  for (const [pillarPosition, pillar] of Object.entries(pillars) as [
    PillarPosition,
    FourPillars[PillarPosition],
  ][]) {
    visible.push(record("visible", pillarPosition, dayMaster, pillar.stem));
    for (const stem of HIDDEN_STEMS_BY_BRANCH[pillar.branch]) {
      hidden.push(record("hidden", pillarPosition, dayMaster, stem));
    }
  }

  return Object.freeze({ visible: Object.freeze(visible), hidden: Object.freeze(hidden) });
}
