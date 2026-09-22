import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { memorialOfferings } from "@/db/schema";
import { PLATFORM_FEE_RATE } from "./catalog";

/** A family may request a gift-out once this much has accrued. */
export const PAYOUT_THRESHOLD_MINOR = 200_000; // ¥2000

export interface FamilyAccrual {
  /** Total paid in for this memorial, in minor units (分). */
  grossMinor: number;
  /** Platform service fee retained (20%). */
  feeMinor: number;
  /** What remains to be gifted to the family after the fee. */
  netMinor: number;
  /** Number of paid offerings/donations counted. */
  count: number;
  thresholdMinor: number;
  /** Whether the ¥1000 threshold to request a gift-out has been reached. */
  reached: boolean;
}

/**
 * Bookkeeping summary for a memorial's paid offerings.
 *
 * All revenue is platform revenue. This function reports the gross and net
 * figures for internal accounting; no funds are transferred to families.
 */
export async function familyAccrual(memorialId: string): Promise<FamilyAccrual> {
  const [row] = await db()
    .select({
      gross: sql<string>`coalesce(sum(${memorialOfferings.amountMinor}), 0)`,
      count: sql<string>`count(*) filter (where ${memorialOfferings.amountMinor} > 0)`,
    })
    .from(memorialOfferings)
    .where(
      and(
        eq(memorialOfferings.memorialId, memorialId),
        ne(memorialOfferings.status, "refunded"),
      ),
    );

  const grossMinor = Number(row?.gross ?? 0);
  const count = Number(row?.count ?? 0);
  const feeMinor = Math.round(grossMinor * PLATFORM_FEE_RATE);
  const netMinor = grossMinor - feeMinor;

  return {
    grossMinor,
    feeMinor,
    netMinor,
    count,
    thresholdMinor: PAYOUT_THRESHOLD_MINOR,
    reached: grossMinor >= PAYOUT_THRESHOLD_MINOR,
  };
}
