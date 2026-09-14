"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The "recently remembered" section on a channel's homepage.
 *
 * Fetched on the client after the page loads, not baked into the server HTML:
 * the homepage is edge-cached for speed, but this list must reflect a memorial
 * the moment it is published. Keeping the list out of the cached HTML and
 * pulling it from `/api/showcase` (short-cached) is what lets a just-published
 * page appear within minutes while the homepage itself stays fast.
 *
 * Renders nothing until the list arrives, and nothing when the channel has
 * none, so an empty homepage stays clean.
 */
type ShowcaseItem = {
  slug: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
  portraitUrl: string | null;
};

export function HomeShowcase({ locale }: { locale: string }) {
  const [items, setItems] = useState<ShowcaseItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/showcase?locale=${encodeURIComponent(locale)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && Array.isArray(data?.memorials)) {
          setItems(data.memorials as ShowcaseItem[]);
        }
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [locale]);

  if (!items || items.length === 0) {
    return null;
  }

  const yearRange = (birthYear: number | null, deathYear: number | null) => {
    if (birthYear && deathYear) return `${birthYear} – ${deathYear}`;
    if (deathYear) return String(deathYear);
    if (birthYear) return String(birthYear);
    return "";
  };

  // The first character of the name, shown when there is no portrait.
  const monogram = (name: string): string => {
    const trimmed = name.trim();
    return trimmed ? [...trimmed][0] ?? "" : "";
  };

  return (
    <section className="section">
      <div className="container stack-lg">
        <div className="showcaseGrid">
          {items.map((m) => {
            const dates = yearRange(m.birthYear, m.deathYear);
            return (
              <Link
                key={m.slug}
                className="showcaseCard"
                href={`/${locale}/memorials/${m.slug}`}
              >
                <span className="showcasePortrait">
                  {m.portraitUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="showcasePortraitImg"
                      src={m.portraitUrl}
                      alt={m.name}
                      loading="lazy"
                    />
                  ) : (
                    <span className="showcaseMonogram" aria-hidden="true">
                      {monogram(m.name)}
                    </span>
                  )}
                </span>
                <span className="showcaseName">{m.name}</span>
                {dates ? <span className="showcaseDates">{dates}</span> : null}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
