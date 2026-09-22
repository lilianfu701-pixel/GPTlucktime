/**
 * Canonical offering catalogue.
 *
 * The four offering kinds a visitor can leave. Prices and display durations are
 * fixed here rather than read from a CMS: they are a product decision, not a
 * per-memorial setting. `createOffering` lazily ensures each product row exists
 * from this table, so the altar works whether or not the seed has run.
 *
 * Durations follow the product brief: incense is a passing gesture (one day), a
 * candle burns for a fortnight, a wreath stands for a season. A donation never
 * expires from the merit book — it is a gift recorded, not a decoration shown.
 */

export type OfferingSlug = "incense" | "candle" | "wreath" | "donation";

export type OfferingCategory = "incense" | "candle" | "wreath" | "custom";

export interface OfferingCatalogEntry {
  readonly slug: OfferingSlug;
  readonly category: OfferingCategory;
  /** Fixed price in minor units (cents). Donation is variable, so 0 here. */
  readonly priceMinor: number;
  readonly currency: "CNY";
  /** Merit/heart points awarded; mirrors the amount for paid gifts. */
  readonly points: number;
  /** How long the offering shows on the altar. Null means it never expires. */
  readonly displayDurationHours: number | null;
}

const HOURS_PER_DAY = 24;

export const OFFERING_CATALOG: Readonly<
  Record<OfferingSlug, OfferingCatalogEntry>
> = {
  incense: {
    slug: "incense",
    category: "incense",
    priceMinor: 0,
    currency: "CNY",
    points: 0,
    displayDurationHours: 1 * HOURS_PER_DAY,
  },
  candle: {
    slug: "candle",
    category: "candle",
    priceMinor: 990,
    currency: "CNY",
    points: 990,
    displayDurationHours: 15 * HOURS_PER_DAY,
  },
  wreath: {
    slug: "wreath",
    category: "wreath",
    priceMinor: 9900,
    currency: "CNY",
    points: 9900,
    displayDurationHours: 90 * HOURS_PER_DAY,
  },
  donation: {
    slug: "donation",
    category: "custom",
    priceMinor: 0,
    currency: "CNY",
    points: 0,
    displayDurationHours: null,
  },
};

/** Platform fee rate applied to paid offerings (all revenue is platform revenue). */
export const PLATFORM_FEE_RATE = 0.2;

export function isOfferingSlug(value: string): value is OfferingSlug {
  return value === "incense" || value === "candle" || value === "wreath" || value === "donation";
}
