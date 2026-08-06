import { db } from "@/db/client";
import { relationshipTypes } from "@/db/schema";

type Row = typeof relationshipTypes.$inferInsert;

const TYPES: Row[] = [
  // ── 配偶 (Spouse) ──────────────────────────────────────────────
  { key: "husband", category: "spouse", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "wife", displayOrder: 1 },
  { key: "wife", category: "spouse", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "husband", displayOrder: 2 },
  { key: "ex_husband", category: "spouse", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "ex_wife", displayOrder: 3 },
  { key: "ex_wife", category: "spouse", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "ex_husband", displayOrder: 4 },

  // ── 父母 / 子女 (Parent / Child) ───────────────────────────────
  { key: "father", category: "parent_child", gender: "male", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "son", displayOrder: 10 },
  { key: "mother", category: "parent_child", gender: "female", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "daughter", displayOrder: 11 },
  { key: "son", category: "parent_child", gender: "male", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "father", displayOrder: 12 },
  { key: "daughter", category: "parent_child", gender: "female", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "mother", displayOrder: 13 },

  // ── 兄弟姐妹 (Siblings) ────────────────────────────────────────
  { key: "older_brother", category: "sibling", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "younger_brother", displayOrder: 20 },
  { key: "older_sister", category: "sibling", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "younger_sister", displayOrder: 21 },
  { key: "younger_brother", category: "sibling", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "older_brother", displayOrder: 22 },
  { key: "younger_sister", category: "sibling", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "older_sister", displayOrder: 23 },

  // ── 祖辈 (Grandparents) ────────────────────────────────────────
  { key: "paternal_grandfather", category: "grandparent_grandchild", gender: "male", generationOffset: 2, isBlood: true, isMarital: false, reverseKey: "paternal_grandson", displayOrder: 30 },
  { key: "paternal_grandmother", category: "grandparent_grandchild", gender: "female", generationOffset: 2, isBlood: true, isMarital: false, reverseKey: "paternal_granddaughter", displayOrder: 31 },
  { key: "maternal_grandfather", category: "grandparent_grandchild", gender: "male", generationOffset: 2, isBlood: true, isMarital: false, reverseKey: "maternal_grandson", displayOrder: 32 },
  { key: "maternal_grandmother", category: "grandparent_grandchild", gender: "female", generationOffset: 2, isBlood: true, isMarital: false, reverseKey: "maternal_granddaughter", displayOrder: 33 },

  // ── 孙辈 (Grandchildren) ───────────────────────────────────────
  { key: "paternal_grandson", category: "grandparent_grandchild", gender: "male", generationOffset: -2, isBlood: true, isMarital: false, reverseKey: "paternal_grandfather", displayOrder: 34 },
  { key: "paternal_granddaughter", category: "grandparent_grandchild", gender: "female", generationOffset: -2, isBlood: true, isMarital: false, reverseKey: "paternal_grandmother", displayOrder: 35 },
  { key: "maternal_grandson", category: "grandparent_grandchild", gender: "male", generationOffset: -2, isBlood: true, isMarital: false, reverseKey: "maternal_grandfather", displayOrder: 36 },
  { key: "maternal_granddaughter", category: "grandparent_grandchild", gender: "female", generationOffset: -2, isBlood: true, isMarital: false, reverseKey: "maternal_grandmother", displayOrder: 37 },

  // ── 曾祖辈 (Great-grandparents) ────────────────────────────────
  { key: "great_grandfather_paternal", category: "great_grandparent", gender: "male", generationOffset: 3, isBlood: true, isMarital: false, reverseKey: "great_grandchild", displayOrder: 40 },
  { key: "great_grandmother_paternal", category: "great_grandparent", gender: "female", generationOffset: 3, isBlood: true, isMarital: false, reverseKey: "great_grandchild", displayOrder: 41 },
  { key: "great_grandfather_maternal", category: "great_grandparent", gender: "male", generationOffset: 3, isBlood: true, isMarital: false, reverseKey: "great_grandchild_maternal", displayOrder: 42 },
  { key: "great_grandmother_maternal", category: "great_grandparent", gender: "female", generationOffset: 3, isBlood: true, isMarital: false, reverseKey: "great_grandchild_maternal", displayOrder: 43 },

  // ── 曾孙辈 (Great-grandchildren) ───────────────────────────────
  { key: "great_grandchild", category: "great_grandparent", gender: null, generationOffset: -3, isBlood: true, isMarital: false, reverseKey: "great_grandfather_paternal", displayOrder: 44 },
  { key: "great_grandchild_maternal", category: "great_grandparent", gender: null, generationOffset: -3, isBlood: true, isMarital: false, reverseKey: "great_grandfather_maternal", displayOrder: 45 },

  // ── 叔伯姑 · 父系长辈 (Paternal extended) ──────────────────────
  { key: "fathers_older_brother", category: "paternal_extended", gender: "male", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "brothers_son", displayOrder: 50 },
  { key: "fathers_older_brothers_wife", category: "paternal_extended", gender: "female", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "brothers_son", displayOrder: 51 },
  { key: "fathers_younger_brother", category: "paternal_extended", gender: "male", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "brothers_son", displayOrder: 52 },
  { key: "fathers_younger_brothers_wife", category: "paternal_extended", gender: "female", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "brothers_son", displayOrder: 53 },
  { key: "fathers_sister", category: "paternal_extended", gender: "female", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "sisters_son", displayOrder: 54 },
  { key: "fathers_sisters_husband", category: "paternal_extended", gender: "male", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "sisters_son", displayOrder: 55 },

  // ── 舅姨 · 母系长辈 (Maternal extended) ────────────────────────
  { key: "mothers_brother", category: "maternal_extended", gender: "male", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "sisters_son", displayOrder: 60 },
  { key: "mothers_brothers_wife", category: "maternal_extended", gender: "female", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "sisters_son", displayOrder: 61 },
  { key: "mothers_sister", category: "maternal_extended", gender: "female", generationOffset: 1, isBlood: true, isMarital: false, reverseKey: "sisters_son", displayOrder: 62 },
  { key: "mothers_sisters_husband", category: "maternal_extended", gender: "male", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "sisters_son", displayOrder: 63 },

  // ── 堂表亲 (Cousins) ───────────────────────────────────────────
  { key: "paternal_older_male_cousin", category: "cousin", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "paternal_younger_male_cousin", displayOrder: 70 },
  { key: "paternal_younger_male_cousin", category: "cousin", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "paternal_older_male_cousin", displayOrder: 71 },
  { key: "paternal_older_female_cousin", category: "cousin", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "paternal_younger_female_cousin", displayOrder: 72 },
  { key: "paternal_younger_female_cousin", category: "cousin", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "paternal_older_female_cousin", displayOrder: 73 },
  { key: "maternal_older_male_cousin", category: "cousin", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "maternal_younger_male_cousin", displayOrder: 74 },
  { key: "maternal_younger_male_cousin", category: "cousin", gender: "male", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "maternal_older_male_cousin", displayOrder: 75 },
  { key: "maternal_older_female_cousin", category: "cousin", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "maternal_younger_female_cousin", displayOrder: 76 },
  { key: "maternal_younger_female_cousin", category: "cousin", gender: "female", generationOffset: 0, isBlood: true, isMarital: false, reverseKey: "maternal_older_female_cousin", displayOrder: 77 },

  // ── 侄甥辈 (Niblings) ──────────────────────────────────────────
  { key: "brothers_son", category: "nibling", gender: "male", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "fathers_older_brother", displayOrder: 80 },
  { key: "brothers_daughter", category: "nibling", gender: "female", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "fathers_older_brother", displayOrder: 81 },
  { key: "sisters_son", category: "nibling", gender: "male", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "mothers_brother", displayOrder: 82 },
  { key: "sisters_daughter", category: "nibling", gender: "female", generationOffset: -1, isBlood: true, isMarital: false, reverseKey: "mothers_sister", displayOrder: 83 },

  // ── 姻亲 · 配偶的家人 (In-laws: spouse's family) ───────────────
  { key: "husbands_father", category: "in_law_spouse_family", gender: "male", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "sons_wife", displayOrder: 90 },
  { key: "husbands_mother", category: "in_law_spouse_family", gender: "female", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "sons_wife", displayOrder: 91 },
  { key: "wifes_father", category: "in_law_spouse_family", gender: "male", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "daughters_husband", displayOrder: 92 },
  { key: "wifes_mother", category: "in_law_spouse_family", gender: "female", generationOffset: 1, isBlood: false, isMarital: true, reverseKey: "daughters_husband", displayOrder: 93 },
  { key: "husbands_older_brother", category: "in_law_spouse_family", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "younger_brothers_wife", displayOrder: 94 },
  { key: "husbands_younger_brother", category: "in_law_spouse_family", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "older_brothers_wife", displayOrder: 95 },
  { key: "husbands_older_sister", category: "in_law_spouse_family", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "younger_brothers_wife", displayOrder: 96 },
  { key: "husbands_younger_sister", category: "in_law_spouse_family", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "older_brothers_wife", displayOrder: 97 },
  { key: "wifes_older_brother", category: "in_law_spouse_family", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "younger_sisters_husband", displayOrder: 98 },
  { key: "wifes_younger_brother", category: "in_law_spouse_family", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "older_sisters_husband", displayOrder: 99 },
  { key: "wifes_older_sister", category: "in_law_spouse_family", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "younger_sisters_husband", displayOrder: 100 },
  { key: "wifes_younger_sister", category: "in_law_spouse_family", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "older_sisters_husband", displayOrder: 101 },

  // ── 姻亲 · 兄弟姐妹/子女的配偶 (In-laws: sibling/child spouses)
  { key: "older_brothers_wife", category: "in_law_sibling_child_spouse", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "husbands_younger_brother", displayOrder: 110 },
  { key: "younger_brothers_wife", category: "in_law_sibling_child_spouse", gender: "female", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "husbands_older_brother", displayOrder: 111 },
  { key: "older_sisters_husband", category: "in_law_sibling_child_spouse", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "wifes_younger_brother", displayOrder: 112 },
  { key: "younger_sisters_husband", category: "in_law_sibling_child_spouse", gender: "male", generationOffset: 0, isBlood: false, isMarital: true, reverseKey: "wifes_older_brother", displayOrder: 113 },
  { key: "sons_wife", category: "in_law_sibling_child_spouse", gender: "female", generationOffset: -1, isBlood: false, isMarital: true, reverseKey: "husbands_father", displayOrder: 114 },
  { key: "daughters_husband", category: "in_law_sibling_child_spouse", gender: "male", generationOffset: -1, isBlood: false, isMarital: true, reverseKey: "wifes_father", displayOrder: 115 },

  // ── 继亲 / 养亲 (Step / Adoptive) ──────────────────────────────
  { key: "stepfather", category: "step_adoptive", gender: "male", generationOffset: 1, isBlood: false, isMarital: false, reverseKey: "stepson", displayOrder: 120 },
  { key: "stepmother", category: "step_adoptive", gender: "female", generationOffset: 1, isBlood: false, isMarital: false, reverseKey: "stepdaughter", displayOrder: 121 },
  { key: "stepson", category: "step_adoptive", gender: "male", generationOffset: -1, isBlood: false, isMarital: false, reverseKey: "stepfather", displayOrder: 122 },
  { key: "stepdaughter", category: "step_adoptive", gender: "female", generationOffset: -1, isBlood: false, isMarital: false, reverseKey: "stepmother", displayOrder: 123 },
  { key: "adoptive_father", category: "step_adoptive", gender: "male", generationOffset: 1, isBlood: false, isMarital: false, reverseKey: "adopted_son", displayOrder: 124 },
  { key: "adoptive_mother", category: "step_adoptive", gender: "female", generationOffset: 1, isBlood: false, isMarital: false, reverseKey: "adopted_daughter", displayOrder: 125 },
  { key: "adopted_son", category: "step_adoptive", gender: "male", generationOffset: -1, isBlood: false, isMarital: false, reverseKey: "adoptive_father", displayOrder: 126 },
  { key: "adopted_daughter", category: "step_adoptive", gender: "female", generationOffset: -1, isBlood: false, isMarital: false, reverseKey: "adoptive_mother", displayOrder: 127 },
];

export async function seedRelationshipTypes(): Promise<{ relationshipTypes: number }> {
  let count = 0;

  for (const row of TYPES) {
    await db()
      .insert(relationshipTypes)
      .values(row)
      .onConflictDoNothing({ target: relationshipTypes.key });
    count++;
  }

  return { relationshipTypes: count };
}
