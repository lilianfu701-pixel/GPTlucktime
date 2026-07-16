import { HIDDEN_STEMS_BY_BRANCH, type HeavenlyStem } from "../pillars/tables";
import type { FourPillars } from "./relations";

export const ELEMENTS = ["wood", "fire", "earth", "metal", "water"] as const;
export type Element = (typeof ELEMENTS)[number];

export const STEM_ELEMENTS: Readonly<Record<HeavenlyStem, Element>> = Object.freeze({
  甲: "wood",
  乙: "wood",
  丙: "fire",
  丁: "fire",
  戊: "earth",
  己: "earth",
  庚: "metal",
  辛: "metal",
  壬: "water",
  癸: "water",
});

export interface ElementCounts {
  readonly visible: Readonly<Record<Element, number>>;
  readonly hidden: Readonly<Record<Element, number>>;
}

function emptyCounts(): Record<Element, number> {
  return { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
}

export function elementForStem(stem: HeavenlyStem): Element {
  return STEM_ELEMENTS[stem];
}

/** Counts stems shown by pillars separately from stems hidden in branches. */
export function countElements(pillars: FourPillars): ElementCounts {
  const visible = emptyCounts();
  const hidden = emptyCounts();

  for (const pillar of Object.values(pillars)) {
    visible[elementForStem(pillar.stem)] += 1;
    for (const stem of HIDDEN_STEMS_BY_BRANCH[pillar.branch]) {
      hidden[elementForStem(stem)] += 1;
    }
  }

  return Object.freeze({
    visible: Object.freeze(visible),
    hidden: Object.freeze(hidden),
  });
}
