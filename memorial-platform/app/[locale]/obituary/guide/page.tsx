import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";
import { GUIDES, RELATED_LABEL, guideTitle } from "@/content/guides";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "obituaryGuide" });
  return {
    title: t("title"),
    description: t("lead"),
    // Real content meant to be found — obituary format / templates.
    robots: { index: true, follow: true },
  };
}

/**
 * "How to write an obituary — format, elements and a template." A genuine
 * content page (not a thin keyword stub) so a search for 讣告 / 讣告格式 /
 * 讣告范文 can land on it, read the guide, and continue to publishing one.
 */
export default async function ObituaryGuidePage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("obituaryGuide");

  const lines = (key: string): string[] =>
    t(key)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  return (
    <main id="main" className="container section">
      <article className="guidePage stack-lg measure">
        <header className="stack">
          <h1>{t("title")}</h1>
          <p className="lede">{t("lead")}</p>
        </header>

        <section className="stack">
          <h2>{t("whatTitle")}</h2>
          <p>{t("whatBody")}</p>
        </section>

        <section className="stack">
          <h2>{t("formatTitle")}</h2>
          <p>{t("formatIntro")}</p>
          <ul className="guideList">
            {lines("formatItems").map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="stack">
          <h2>{t("templateTitle")}</h2>
          <p className="muted">{t("templateNote")}</p>
          <div className="obituaryTemplate">{t("template")}</div>
        </section>

        <section className="stack">
          <h2>{t("onlineTitle")}</h2>
          <p>{t("onlineBody")}</p>
        </section>

        <section className="stack">
          <h2>{t("tipsTitle")}</h2>
          <ul className="guideList">
            {lines("tipsItems").map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="stack">
          <h2>{t("ctaTitle")}</h2>
          <p>
            <Link
              className="button buttonPrimary"
              href={`/${locale}/obituary/new`}
            >
              {t("ctaButton")}
            </Link>
          </p>
        </section>

        <nav
          className="stack"
          aria-label={RELATED_LABEL[locale] ?? RELATED_LABEL.en}
        >
          <h2>{RELATED_LABEL[locale] ?? RELATED_LABEL.en}</h2>
          <ul className="guideList">
            {GUIDES.map((g) => (
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
