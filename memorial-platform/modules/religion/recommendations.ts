export type CompatibilityLevel =
  | "recommended"
  | "optional"
  | "needs_family_confirmation"
  | "not_recommended"
  | "prohibited_combination";

/**
 * A rule as stored. A null field is a wildcard: the rule says nothing about
 * that dimension and therefore does not constrain it.
 */
export type CompatibilityRule = {
  ritualVersionId: string;
  level: CompatibilityLevel;
  explanationKey: string;
  religionId?: string | null;
  denominationId?: string | null;
  cultureId?: string | null;
  country?: string | null;
};

/** What the family told us about themselves. Any of it may be unknown. */
export type FamilyContext = {
  religionId?: string | null;
  denominationId?: string | null;
  cultureIds?: readonly string[];
  country?: string | null;
};

/**
 * How a ritual should be presented, if at all.
 *
 * Mapped from doc 05 section 4. `suggested` and `also_possible` may be shown as
 * candidates; nothing in any bucket is ever switched on by the platform.
 */
export type Presentation =
  | "suggested"
  | "also_possible"
  | "needs_confirmation"
  | "hidden"
  | "blocked";

export type Suggestion = {
  ritualVersionId: string;
  level: CompatibilityLevel;
  explanationKey: string;
  presentation: Presentation;
  /** True where the family must be shown the difference and asked. */
  requiresFamilyConfirmation: boolean;
};

/**
 * Most restrictive first.
 *
 * When several reviewed rules describe the same ritual for one family, the
 * cautious one wins. Two communities disagreeing about a practice is the
 * ordinary case, and the wrong direction to resolve it in is the permissive one.
 */
const RESTRICTIVENESS: Record<CompatibilityLevel, number> = {
  prohibited_combination: 5,
  not_recommended: 4,
  needs_family_confirmation: 3,
  optional: 2,
  recommended: 1,
};

const PRESENTATION: Record<CompatibilityLevel, Presentation> = {
  recommended: "suggested",
  optional: "also_possible",
  needs_family_confirmation: "needs_confirmation",
  not_recommended: "hidden",
  prohibited_combination: "blocked",
};

/**
 * Whether a rule speaks to this family at all.
 *
 * Every field the rule specifies must match. A rule about Buddhist funerals in
 * Japan says nothing about a Buddhist family in Brazil, and treating it as
 * though it did is how one community's custom gets presented as a faith's rule.
 */
function ruleApplies(rule: CompatibilityRule, context: FamilyContext): boolean {
  if (rule.religionId && rule.religionId !== context.religionId) {
    return false;
  }

  if (rule.denominationId && rule.denominationId !== context.denominationId) {
    return false;
  }

  if (rule.cultureId && !(context.cultureIds ?? []).includes(rule.cultureId)) {
    return false;
  }

  if (rule.country && rule.country !== context.country) {
    return false;
  }

  return true;
}

/**
 * Works out what may be offered to a family.
 *
 * A ritual with no matching rule does not appear. It is not treated as
 * `optional` by default: doc 05 section 4 requires the engine to offer nothing
 * where it does not know, and a silent default would turn absent research into
 * an apparent endorsement.
 *
 * Nothing returned here is enabled. Every suggestion still has to be switched on
 * by the family, one at a time.
 */
export function evaluateCompatibility(
  rules: readonly CompatibilityRule[],
  context: FamilyContext,
): Suggestion[] {
  const strongest = new Map<string, CompatibilityRule>();

  for (const rule of rules) {
    if (!ruleApplies(rule, context)) {
      continue;
    }

    const current = strongest.get(rule.ritualVersionId);
    if (
      !current ||
      RESTRICTIVENESS[rule.level] > RESTRICTIVENESS[current.level]
    ) {
      strongest.set(rule.ritualVersionId, rule);
    }
  }

  return [...strongest.values()]
    .map((rule) => ({
      ritualVersionId: rule.ritualVersionId,
      level: rule.level,
      explanationKey: rule.explanationKey,
      presentation: PRESENTATION[rule.level],
      requiresFamilyConfirmation: rule.level === "needs_family_confirmation",
    }))
    .sort((a, b) => a.ritualVersionId.localeCompare(b.ritualVersionId));
}

/**
 * The candidates worth putting in front of a family.
 *
 * Excludes anything hidden or blocked. `needs_confirmation` is included on
 * purpose: the family should see it, together with the explanation of why it
 * varies, and decide for themselves.
 */
export function offerableSuggestions(
  suggestions: readonly Suggestion[],
): Suggestion[] {
  return suggestions.filter(
    (suggestion) =>
      suggestion.presentation === "suggested" ||
      suggestion.presentation === "also_possible" ||
      suggestion.presentation === "needs_confirmation",
  );
}

/**
 * Whether a family may switch a ritual on.
 *
 * A blocked combination cannot be enabled even deliberately: the point of a
 * reviewed prohibition is that it does not yield to a checkbox. Everything else
 * is the family's decision, including a practice we would not have suggested.
 */
export function mayEnable(suggestion: Suggestion | undefined): boolean {
  if (!suggestion) {
    // No reviewed rule reaches this family. Nothing to enable.
    return false;
  }

  return suggestion.presentation !== "blocked";
}
