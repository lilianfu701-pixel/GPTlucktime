import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * Crawler policy.
 *
 * The disallow list is a courtesy, not a control: a crawler that ignores it
 * still gets nothing, because each of these paths refuses the request itself.
 * `/admin` in particular answers 404 to anyone who is not staff, so listing it
 * here does not disclose a way in.
 *
 * Individual memorials are not listed. Whether one may be indexed depends on
 * what its family chose, which is expressed per page through `noindex` and
 * through the sitemap, not through a pattern that would have to enumerate them.
 */
export default function robots(): MetadataRoute.Robots {
  const appUrl = env().APP_URL.replace(/\/+$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          // Staff surfaces, and the sign-in flow, have nothing to index.
          "/*/admin",
          "/*/sign-in",
        ],
      },
    ],
    sitemap: `${appUrl}/sitemap.xml`,
    host: appUrl,
  };
}
