import { randomBytes } from "node:crypto";

/**
 * Builds the URL segment for a memorial.
 *
 * The name is transliterated where we can and otherwise dropped, then a short
 * random suffix is appended. The suffix is what makes the slug unique, so two
 * people with the same name never collide, and a name written entirely in a
 * script we cannot transliterate still produces a usable address.
 *
 * The suffix is not a secret. An unlisted memorial is protected by the access
 * check, never by the address being hard to guess.
 */
const SUFFIX_BYTES = 4;

export function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      // Strip combining marks so "José" becomes "jose" rather than "jos".
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
  );
}

export function buildMemorialSlug(primaryName: string): string {
  const base = slugify(primaryName);
  const suffix = randomBytes(SUFFIX_BYTES).toString("hex");
  return base.length > 0 ? `${base}-${suffix}` : `memorial-${suffix}`;
}
