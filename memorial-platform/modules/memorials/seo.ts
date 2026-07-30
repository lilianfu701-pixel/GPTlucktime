import { SUPPORTED_LOCALES } from "@/lib/locale";
import type { Locale } from "@/lib/locale";

/**
 * What search engines are told about a memorial.
 *
 * Every value here is derived from the memorial's stored privacy. Nothing is
 * taken from a request, a query parameter or a client-supplied flag: doc 07
 * section 7 makes indexability a family's decision, and a page that could be
 * asked to index itself would let anyone else make it.
 */

export type MemorialSeoFacts = {
  slug: string;
  visibility: "public" | "unlisted" | "invite_only";
  status:
    | "draft"
    | "published"
    | "restricted"
    | "hidden"
    | "pending_deletion"
    | "merged";
  searchEngineIndexable: boolean;
  /** Locales with a published rendering. The source language is always present. */
  availableLocales: readonly string[];
};

export type RobotsDirective = {
  index: boolean;
  follow: boolean;
};

/**
 * Whether a memorial belongs in a search engine at all.
 *
 * Both conditions are required: public visibility, and the family having left
 * indexing on. A family who chose "anyone with the link" has already said they
 * do not want it found, so the flag alone cannot put it back.
 */
export function isIndexable(memorial: MemorialSeoFacts): boolean {
  return (
    memorial.visibility === "public" &&
    memorial.status === "published" &&
    memorial.searchEngineIndexable
  );
}

export function robotsFor(memorial: MemorialSeoFacts): RobotsDirective {
  if (!isIndexable(memorial)) {
    // `nofollow` as well as `noindex`: a crawler that follows links out of an
    // unlisted page maps the family's other pages from it.
    return { index: false, follow: false };
  }
  return { index: true, follow: true };
}

export function robotsContent(directive: RobotsDirective): string {
  return [
    directive.index ? "index" : "noindex",
    directive.follow ? "follow" : "nofollow",
  ].join(", ");
}

export function memorialUrl(input: {
  appUrl: string;
  locale: string;
  slug: string;
}): string {
  const base = input.appUrl.replace(/\/+$/, "");
  return `${base}/${input.locale}/memorials/${input.slug}`;
}

/**
 * The address a search engine should treat as authoritative.
 *
 * Returns null for anything not indexable, so a private page does not publish a
 * canonical pointing at itself.
 */
export function canonicalFor(input: {
  appUrl: string;
  locale: string;
  memorial: MemorialSeoFacts;
}): string | null {
  if (!isIndexable(input.memorial)) {
    return null;
  }
  return memorialUrl({
    appUrl: input.appUrl,
    locale: input.locale,
    slug: input.memorial.slug,
  });
}

export type AlternateLink = { hrefLang: string; href: string };

/**
 * Alternates for the languages this memorial actually has.
 *
 * Only locales with a published rendering are listed. Advertising a translation
 * that does not exist sends someone to a page in a language they cannot read
 * and tells a search engine something untrue.
 */
export function alternatesFor(input: {
  appUrl: string;
  memorial: MemorialSeoFacts;
}): AlternateLink[] {
  if (!isIndexable(input.memorial)) {
    return [];
  }

  const available = input.memorial.availableLocales.filter(
    (locale): locale is Locale =>
      (SUPPORTED_LOCALES as readonly string[]).includes(locale),
  );

  return available.map((locale) => ({
    hrefLang: locale,
    href: memorialUrl({
      appUrl: input.appUrl,
      locale,
      slug: input.memorial.slug,
    }),
  }));
}

export type PersonStructuredData = {
  "@context": "https://schema.org";
  "@type": "Person";
  name: string;
  birthDate?: string;
  deathDate?: string;
  url: string;
};

/**
 * Structured data for a public memorial.
 *
 * Deliberately minimal: a name, the years, and the address. No owner, no family
 * relationships, no contact details, no place of residence. Doc 07 section 7
 * calls for safe structured data, and a machine-readable block listing a
 * bereaved family's relationships is a gift to anyone building a target list.
 *
 * Returns null for anything not indexable rather than emitting a reduced
 * version, because there is no version of this that a private page should
 * publish.
 */
export function structuredDataFor(input: {
  appUrl: string;
  locale: string;
  memorial: MemorialSeoFacts;
  primaryName: string;
  birthYear?: number | null;
  deathYear?: number | null;
}): PersonStructuredData | null {
  if (!isIndexable(input.memorial)) {
    return null;
  }

  const data: PersonStructuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: input.primaryName,
    url: memorialUrl({
      appUrl: input.appUrl,
      locale: input.locale,
      slug: input.memorial.slug,
    }),
  };

  // Years only. A full date of birth is a common identity-verification answer,
  // and publishing one for a person whose relatives share a surname helps
  // nobody who is mourning.
  if (input.birthYear) {
    data.birthDate = String(input.birthYear);
  }
  if (input.deathYear) {
    data.deathDate = String(input.deathYear);
  }

  return data;
}

/** The HTTP status a memorial page should answer with. */
export function statusForMemorial(memorial: MemorialSeoFacts | null): number {
  if (!memorial) {
    return 404;
  }

  switch (memorial.status) {
    case "pending_deletion":
      // Only where it was public. Saying "gone" about a private memorial
      // confirms it once existed.
      return memorial.visibility === "public" ? 410 : 404;
    case "merged":
      return 301;
    case "draft":
    case "hidden":
      return 404;
    case "published":
    case "restricted":
      return memorial.visibility === "invite_only" ? 404 : 200;
  }
}
