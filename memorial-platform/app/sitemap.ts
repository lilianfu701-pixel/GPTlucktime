import { and, eq, isNull } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";
import { env } from "@/lib/env";
import { LAUNCH_LOCALES } from "@/lib/locale";
import { memorialUrl } from "@/modules/memorials/seo";

/**
 * The sitemap.
 *
 * The conditions are in the SQL statement, matching the search query for the
 * same reason: a sitemap is a published list of addresses, and a memorial that
 * has just been made private must drop out of it on the next generation without
 * waiting for anything else to catch up.
 *
 * `searchEngineIndexable` is part of the filter as well as visibility. A family
 * can be happy for a page to be public and still not want it indexed.
 */
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const MAX_ENTRIES = 5000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const appUrl = env().APP_URL;

  const rows = await db()
    .select({
      slug: memorials.slug,
      publishedAt: memorials.publishedAt,
    })
    .from(memorials)
    .where(
      and(
        eq(memorials.visibility, "public"),
        eq(memorials.status, "published"),
        eq(memorials.searchEngineIndexable, true),
        isNull(memorials.deletionRequestedAt),
      ),
    )
    .limit(MAX_ENTRIES);

  const entries: MetadataRoute.Sitemap = LAUNCH_LOCALES.map((locale) => ({
    url: `${appUrl.replace(/\/+$/, "")}/${locale}`,
    changeFrequency: "weekly",
    priority: 1,
  }));

  for (const row of rows) {
    for (const locale of LAUNCH_LOCALES) {
      entries.push({
        url: memorialUrl({ appUrl, locale, slug: row.slug }),
        lastModified: row.publishedAt ?? undefined,
        changeFrequency: "monthly",
        priority: 0.7,
      });
    }
  }

  return entries;
}
