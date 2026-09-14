import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  GUIDES,
  RELATED_LABEL,
  findGuide,
  guideContent,
  guideTitle,
} from "@/content/guides";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await props.params;
  const guide = findGuide(slug);
  if (!guide) return { robots: { index: false, follow: false } };
  const c = guideContent(guide, locale);
  return {
    title: c.title,
    description: c.description,
    robots: { index: true, follow: true },
  };
}

/**
 * A long-tail content guide (eulogy, condolence message, funeral couplets…),
 * cross-linked with the others and the obituary-writing guide so the topic
 * cluster reinforces itself for search.
 */
export default async function GuidePage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await props.params;
  const guide = findGuide(slug);
  if (!guide) {
    notFound();
  }
  setRequestLocale(locale);
  const c = guideContent(guide, locale);
  const obituaryGuide = await getTranslations("obituaryGuide");

  const related = GUIDES.filter((g) => g.slug !== slug);
  const relatedLabel = RELATED_LABEL[locale] ?? RELATED_LABEL.en!;

  return (
    <main id="main" className="container section">
      <article className="guidePage stack-lg measure">
        <header className="stack">
          <h1>{c.title}</h1>
          <p className="lede">{c.intro}</p>
        </header>

        {c.sections.map((section, i) => (
          <section className="stack" key={i}>
            <h2>{section.heading}</h2>
            <p>{section.body}</p>
          </section>
        ))}

        {c.examples ? (
          <section className="stack">
            {c.examplesTitle ? <h2>{c.examplesTitle}</h2> : null}
            {c.examplesNote ? (
              <p className="muted">{c.examplesNote}</p>
            ) : null}
            <div className="obituaryTemplate">{c.examples}</div>
          </section>
        ) : null}

        <section className="stack">
          <h2>{c.ctaTitle}</h2>
          <p>
            <Link
              className="button buttonPrimary"
              href={`/${locale}/${c.ctaHref}`}
            >
              {c.ctaButton}
            </Link>
          </p>
        </section>

        <nav className="stack" aria-label={relatedLabel}>
          <h2>{relatedLabel}</h2>
          <ul className="guideList">
            <li>
              <Link href={`/${locale}/obituary/guide`}>
                {obituaryGuide("title")}
              </Link>
            </li>
            {related.map((g) => (
              <li key={g.slug}>
                <Link href={`/${locale}/guide/${g.slug}`}>
                  {guideTitle(g, locale)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </article>
    </main>
  );
}
