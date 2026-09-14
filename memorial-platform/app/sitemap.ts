import { and, eq, isNull } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { db } from "@/db/client";
import { memorials } from "@/db/schema";
import { siteUrl } from "@/lib/env";
import { DEFAULT_LOCALE, LAUNCH_LOCALES } from "@/lib/locale";
import { memorialUrl } from "@/modules/memorials/seo";
import { GUIDES } from "@/content/guides";

/**
 * The hreflang map for one logical page: every launch-locale variant plus an
 * `x-default`. Only launch locales are advertised — a thin auto-locale should
 * not be offered to Google as an equal translation.
 */
function languagesFor(make: (locale: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const locale of LAUNCH_LOCALES) {
    map[locale] = make(locale);
  }
  map["x-default"] = make(DEFAULT_LOCALE);
  return map;
}

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
  const appUrl = siteUrl();

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

  const base = appUrl.replace(/\/+$/, "");
  const homeLanguages = languagesFor((locale) => `${base}/${locale}`);

  const entries: MetadataRoute.Sitemap = LAUNCH_LOCALES.map((locale) => ({
    url: `${base}/${locale}`,
    changeFrequency: "weekly",
    priority: 1,
    alternates: { languages: homeLanguages },
  }));

  // Evergreen content pages (help centre, obituary-writing guide, long-tail
  // guides) — indexable and worth crawling, so list them with hreflang.
  const contentPaths = [
    "help",
    "obituary/guide",
    ...GUIDES.map((g) => `guide/${g.slug}`),
  ];
  for (const path of contentPaths) {
    const languages = languagesFor((locale) => `${base}/${locale}/${path}`);
    for (const locale of LAUNCH_LOCALES) {
      entries.push({
        url: `${base}/${locale}/${path}`,
        changeFrequency: "monthly",
        priority: 0.6,
        alternates: { languages },
      });
    }
  }

  for (const row of rows) {
    const languages = languagesFor((locale) =>
      memorialUrl({ appUrl, locale, slug: row.slug }),
    );
    for (const locale of LAUNCH_LOCALES) {
      entries.push({
        url: memorialUrl({ appUrl, locale, slug: row.slug }),
        lastModified: row.publishedAt ?? undefined,
        changeFrequency: "monthly",
        priority: 0.7,
        alternates: { languages },
      });
    }
  }

  return entries;
}
