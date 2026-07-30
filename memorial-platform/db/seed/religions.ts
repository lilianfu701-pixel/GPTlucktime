import { db } from "@/db/client";
import {
  culturalTraditions,
  religions,
  ritualDefinitions,
} from "@/db/schema";

/**
 * Neutral classification entries.
 *
 * What this seed contains: the fact that a tradition exists, and the fact that
 * a way of remembering exists as a concept.
 *
 * What it deliberately does not contain: any statement about what a faith
 * teaches, which practices suit which tradition, or which combinations are
 * forbidden. Those live in ritual versions, and doc 05 section 6 requires each
 * one to carry a verifiable source, an explicit scope and a named reviewer
 * before it can be published. Doc 11 section 4 leaves the advisers, the
 * acceptable sources and the review separation still to be decided.
 *
 * The consequence is intended: with no published versions, the platform offers
 * no ritual to any family. Nothing is better than a guess here.
 *
 * `adminLabel` is a working label for administrators. Reader-facing names come
 * from reviewed translations, never from these strings.
 */

const RELIGION_CLASSIFICATIONS: { slug: string; adminLabel: string }[] = [
  { slug: "secular", adminLabel: "No religion or secular remembrance" },
  { slug: "christian", adminLabel: "Christianity" },
  { slug: "muslim", adminLabel: "Islam" },
  { slug: "buddhist", adminLabel: "Buddhism" },
  { slug: "taoist-chinese-folk", adminLabel: "Taoism and Chinese folk tradition" },
  { slug: "hindu", adminLabel: "Hinduism" },
  { slug: "jewish", adminLabel: "Judaism" },
  { slug: "sikh", adminLabel: "Sikhism" },
  { slug: "shinto", adminLabel: "Shinto" },
  { slug: "bahai", adminLabel: "Baha'i Faith" },
  { slug: "indigenous-local", adminLabel: "Indigenous or local tradition" },
  { slug: "multi-tradition", adminLabel: "More than one tradition" },
  { slug: "family-custom", adminLabel: "A tradition of the family's own" },
  { slug: "undisclosed", adminLabel: "Not disclosed" },
];

/**
 * Cultural traditions, kept separate from religion.
 *
 * Region hints are navigational, not a claim that a tradition is confined to
 * those countries. Diaspora communities are the ordinary case, not an exception.
 */
const CULTURAL_TRADITIONS: {
  slug: string;
  adminLabel: string;
  regionHints: string[];
}[] = [
  { slug: "han-chinese", adminLabel: "Han Chinese", regionHints: ["CN", "TW", "HK", "SG", "MY"] },
  { slug: "japanese", adminLabel: "Japanese", regionHints: ["JP"] },
  { slug: "korean", adminLabel: "Korean", regionHints: ["KR"] },
  { slug: "vietnamese", adminLabel: "Vietnamese", regionHints: ["VN"] },
  { slug: "south-asian", adminLabel: "South Asian", regionHints: ["IN", "PK", "BD", "LK", "NP"] },
  { slug: "arab", adminLabel: "Arab", regionHints: ["EG", "SA", "MA", "JO", "LB"] },
  { slug: "latin-american", adminLabel: "Latin American", regionHints: ["MX", "BR", "AR", "CO", "PE"] },
  { slug: "west-african", adminLabel: "West African", regionHints: ["NG", "GH", "SN", "ML"] },
  { slug: "east-african", adminLabel: "East African", regionHints: ["KE", "ET", "TZ", "UG"] },
  { slug: "western-european", adminLabel: "Western European", regionHints: ["FR", "DE", "NL", "IT", "ES"] },
  { slug: "eastern-european", adminLabel: "Eastern European", regionHints: ["RU", "PL", "UA", "RO"] },
  { slug: "nordic", adminLabel: "Nordic", regionHints: ["SE", "NO", "DK", "FI", "IS"] },
];

/**
 * The identities of the first ways of remembering, from doc 05 section 3.
 *
 * An identity only says the concept exists. Whether a given tradition offers it,
 * and in what circumstances, is what a version records — and there are none.
 */
const RITUAL_DEFINITIONS: {
  slug: string;
  actionType:
    | "offering"
    | "light"
    | "prayer"
    | "recitation"
    | "gesture"
    | "message"
    | "contribution"
    | "planting"
    | "observance"
    | "custom";
  adminLabel: string;
}[] = [
  { slug: "lay-flowers", actionType: "offering", adminLabel: "Lay flowers" },
  { slug: "light-candle", actionType: "light", adminLabel: "Light a candle" },
  { slug: "offer-incense", actionType: "offering", adminLabel: "Offer incense" },
  { slug: "pray", actionType: "prayer", adminLabel: "Pray or intercede" },
  { slug: "recite-scripture", actionType: "recitation", adminLabel: "Recite scripture" },
  { slug: "place-stone", actionType: "offering", adminLabel: "Place a stone" },
  { slug: "silent-remembrance", actionType: "gesture", adminLabel: "Silent remembrance" },
  { slug: "bow", actionType: "gesture", adminLabel: "Bow" },
  { slug: "leave-message", actionType: "message", adminLabel: "Leave a message" },
  { slug: "share-memory", actionType: "message", adminLabel: "Share a memory" },
  { slug: "charitable-gift", actionType: "contribution", adminLabel: "Charitable gift" },
  { slug: "plant-tree", actionType: "planting", adminLabel: "Plant a tree" },
  { slug: "virtual-offering", actionType: "offering", adminLabel: "Virtual offering" },
  { slug: "anniversary-observance", actionType: "observance", adminLabel: "Anniversary observance" },
  { slug: "family-custom-action", actionType: "custom", adminLabel: "A custom of the family's own" },
];

export type SeedCounts = {
  religions: number;
  culturalTraditions: number;
  ritualDefinitions: number;
  ritualVersions: number;
};

/**
 * Inserts the classification entries. Safe to run repeatedly.
 */
export async function seedReligions(): Promise<SeedCounts> {
  await db()
    .insert(religions)
    .values(RELIGION_CLASSIFICATIONS)
    .onConflictDoNothing({ target: religions.slug });

  await db()
    .insert(culturalTraditions)
    .values(CULTURAL_TRADITIONS)
    .onConflictDoNothing({ target: culturalTraditions.slug });

  await db()
    .insert(ritualDefinitions)
    .values(RITUAL_DEFINITIONS)
    .onConflictDoNothing({ target: ritualDefinitions.slug });

  return {
    religions: RELIGION_CLASSIFICATIONS.length,
    culturalTraditions: CULTURAL_TRADITIONS.length,
    ritualDefinitions: RITUAL_DEFINITIONS.length,
    // Stated explicitly so a reader of the seed output sees that nothing is
    // offerable yet, rather than assuming the catalogue is ready.
    ritualVersions: 0,
  };
}

export const SEEDED_RELIGION_SLUGS = RELIGION_CLASSIFICATIONS.map(
  (entry) => entry.slug,
);
export const SEEDED_RITUAL_SLUGS = RITUAL_DEFINITIONS.map((entry) => entry.slug);
