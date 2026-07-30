import { describe, expect, it } from "vitest";
import {
  evaluateCompatibility,
  mayEnable,
  offerableSuggestions,
} from "@/modules/religion/recommendations";
import type {
  CompatibilityLevel,
  CompatibilityRule,
  FamilyContext,
} from "@/modules/religion/recommendations";

const BUDDHIST = "religion-buddhist";
const CHRISTIAN = "religion-christian";
const THERAVADA = "denomination-theravada";
const HAN = "culture-han";
const JAPANESE = "culture-japanese";
const INCENSE = "version-incense";
const FLOWERS = "version-flowers";

const family: FamilyContext = {
  religionId: BUDDHIST,
  denominationId: THERAVADA,
  cultureIds: [HAN],
  country: "SG",
};

const rule = (
  overrides: Partial<CompatibilityRule> & { level: CompatibilityLevel },
): CompatibilityRule => ({
  ritualVersionId: INCENSE,
  explanationKey: "ritual.explanation.default",
  ...overrides,
});

describe("every compatibility level maps to a presentation", () => {
  const cases: { level: CompatibilityLevel; presentation: string }[] = [
    { level: "recommended", presentation: "suggested" },
    { level: "optional", presentation: "also_possible" },
    { level: "needs_family_confirmation", presentation: "needs_confirmation" },
    { level: "not_recommended", presentation: "hidden" },
    { level: "prohibited_combination", presentation: "blocked" },
  ];

  for (const testCase of cases) {
    it(`${testCase.level} is presented as ${testCase.presentation}`, () => {
      const [suggestion] = evaluateCompatibility(
        [rule({ level: testCase.level, religionId: BUDDHIST })],
        family,
      );
      expect(suggestion?.presentation).toBe(testCase.presentation);
    });
  }
});

describe("nothing is enabled by evaluation", () => {
  it("returns descriptions, never a switched-on state", () => {
    // Doc 05 section 4: choosing a religion must not turn any ritual on.
    const suggestions = evaluateCompatibility(
      [
        rule({ level: "recommended", religionId: BUDDHIST }),
        rule({ ritualVersionId: FLOWERS, level: "optional", religionId: BUDDHIST }),
      ],
      family,
    );

    expect(suggestions).toHaveLength(2);
    for (const suggestion of suggestions) {
      expect(Object.keys(suggestion).sort()).toEqual([
        "explanationKey",
        "level",
        "presentation",
        "requiresFamilyConfirmation",
        "ritualVersionId",
      ]);
      expect("enabled" in suggestion).toBe(false);
    }
  });
});

describe("a ritual with no matching rule", () => {
  it("does not appear at all", () => {
    // Absent research must not read as an endorsement, so there is no default
    // level. Doc 05 section 9.
    expect(evaluateCompatibility([], family)).toEqual([]);
  });

  it("is not treated as optional", () => {
    const suggestions = evaluateCompatibility(
      [rule({ level: "recommended", religionId: CHRISTIAN })],
      family,
    );
    expect(suggestions).toEqual([]);
  });

  it("cannot be enabled", () => {
    expect(mayEnable(undefined)).toBe(false);
  });
});

describe("rule scope", () => {
  it("ignores a rule for another religion", () => {
    expect(
      evaluateCompatibility(
        [rule({ level: "recommended", religionId: CHRISTIAN })],
        family,
      ),
    ).toEqual([]);
  });

  it("ignores a rule for another denomination of the same religion", () => {
    // Practice varies more between denominations than the top-level
    // classification suggests.
    expect(
      evaluateCompatibility(
        [
          rule({
            level: "recommended",
            religionId: BUDDHIST,
            denominationId: "denomination-mahayana",
          }),
        ],
        family,
      ),
    ).toEqual([]);
  });

  it("ignores a rule for a culture this family did not name", () => {
    expect(
      evaluateCompatibility(
        [rule({ level: "recommended", cultureId: JAPANESE })],
        family,
      ),
    ).toEqual([]);
  });

  it("ignores a rule for another country", () => {
    // A rule about Buddhist funerals in Japan says nothing about a Buddhist
    // family in Brazil.
    expect(
      evaluateCompatibility(
        [rule({ level: "recommended", religionId: BUDDHIST, country: "JP" })],
        family,
      ),
    ).toEqual([]);
  });

  it("applies a rule that specifies nothing to everyone", () => {
    // A secular action, reviewed as appropriate regardless of tradition.
    const [suggestion] = evaluateCompatibility([rule({ level: "optional" })], {
      religionId: null,
      cultureIds: [],
      country: null,
    });
    expect(suggestion?.level).toBe("optional");
  });

  it("matches one of several cultures the family named", () => {
    const [suggestion] = evaluateCompatibility(
      [rule({ level: "recommended", cultureId: JAPANESE })],
      { ...family, cultureIds: [HAN, JAPANESE] },
    );
    expect(suggestion?.level).toBe("recommended");
  });

  it("requires every specified field to match, not merely one", () => {
    // Right religion, wrong country.
    expect(
      evaluateCompatibility(
        [
          rule({
            level: "recommended",
            religionId: BUDDHIST,
            country: "TH",
          }),
        ],
        family,
      ),
    ).toEqual([]);
  });
});

describe("conflicting rules", () => {
  it("resolve to the most restrictive", () => {
    // Two communities disagreeing about a practice is ordinary. The wrong
    // direction to resolve it in is the permissive one.
    const [suggestion] = evaluateCompatibility(
      [
        rule({ level: "recommended", religionId: BUDDHIST }),
        rule({ level: "not_recommended", cultureId: HAN }),
      ],
      family,
    );

    expect(suggestion?.level).toBe("not_recommended");
    expect(suggestion?.presentation).toBe("hidden");
  });

  it("let a prohibition beat everything", () => {
    const [suggestion] = evaluateCompatibility(
      [
        rule({ level: "recommended", religionId: BUDDHIST }),
        rule({ level: "optional", cultureId: HAN }),
        rule({ level: "prohibited_combination", country: "SG" }),
        rule({ level: "needs_family_confirmation", denominationId: THERAVADA }),
      ],
      family,
    );

    expect(suggestion?.level).toBe("prohibited_combination");
    expect(suggestion?.presentation).toBe("blocked");
  });

  it("prefer confirmation over a bare recommendation", () => {
    const [suggestion] = evaluateCompatibility(
      [
        rule({ level: "recommended", religionId: BUDDHIST }),
        rule({ level: "needs_family_confirmation", cultureId: HAN }),
      ],
      family,
    );

    expect(suggestion?.level).toBe("needs_family_confirmation");
    expect(suggestion?.requiresFamilyConfirmation).toBe(true);
  });

  it("resolve each ritual independently", () => {
    const suggestions = evaluateCompatibility(
      [
        rule({ ritualVersionId: INCENSE, level: "recommended", religionId: BUDDHIST }),
        rule({ ritualVersionId: INCENSE, level: "prohibited_combination", cultureId: HAN }),
        rule({ ritualVersionId: FLOWERS, level: "recommended", religionId: BUDDHIST }),
      ],
      family,
    );

    const byVersion = new Map(suggestions.map((s) => [s.ritualVersionId, s]));
    expect(byVersion.get(INCENSE)?.level).toBe("prohibited_combination");
    expect(byVersion.get(FLOWERS)?.level).toBe("recommended");
  });

  it("do not depend on the order the rules arrive in", () => {
    const rules = [
      rule({ level: "prohibited_combination", country: "SG" }),
      rule({ level: "recommended", religionId: BUDDHIST }),
    ];

    const forward = evaluateCompatibility(rules, family);
    const reversed = evaluateCompatibility([...rules].reverse(), family);

    expect(forward).toEqual(reversed);
  });
});

describe("what is put in front of a family", () => {
  it("includes suggested, also possible and needs confirmation", () => {
    const suggestions = evaluateCompatibility(
      [
        rule({ ritualVersionId: "a", level: "recommended" }),
        rule({ ritualVersionId: "b", level: "optional" }),
        rule({ ritualVersionId: "c", level: "needs_family_confirmation" }),
        rule({ ritualVersionId: "d", level: "not_recommended" }),
        rule({ ritualVersionId: "e", level: "prohibited_combination" }),
      ],
      family,
    );

    expect(offerableSuggestions(suggestions).map((s) => s.ritualVersionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("excludes a hidden ritual from the offer", () => {
    // Doc 05 section 4: not_recommended is not shown by default.
    const suggestions = evaluateCompatibility(
      [rule({ level: "not_recommended" })],
      family,
    );
    expect(offerableSuggestions(suggestions)).toEqual([]);
  });
});

describe("mayEnable", () => {
  it("allows a suggested ritual", () => {
    const [suggestion] = evaluateCompatibility(
      [rule({ level: "recommended", religionId: BUDDHIST })],
      family,
    );
    expect(mayEnable(suggestion)).toBe(true);
  });

  it("allows one the family was asked to confirm", () => {
    const [suggestion] = evaluateCompatibility(
      [rule({ level: "needs_family_confirmation" })],
      family,
    );
    expect(mayEnable(suggestion)).toBe(true);
  });

  it("allows a practice we would not have suggested", () => {
    // The family knows their own customs. `not_recommended` shapes what we
    // offer, not what they are permitted to choose.
    const [suggestion] = evaluateCompatibility(
      [rule({ level: "not_recommended" })],
      family,
    );
    expect(mayEnable(suggestion)).toBe(true);
  });

  it("refuses a reviewed prohibition", () => {
    // A prohibition that yields to a checkbox is not a prohibition.
    const [suggestion] = evaluateCompatibility(
      [rule({ level: "prohibited_combination" })],
      family,
    );
    expect(mayEnable(suggestion)).toBe(false);
  });
});
