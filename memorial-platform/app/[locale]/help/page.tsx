import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

const FAQ_ITEMS = [1, 2, 3, 4, 5, 6] as const;

export async function generateMetadata(props: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "help" });
  return {
    title: t("title"),
    description: t("intro"),
    robots: { index: true, follow: true },
  };
}

/**
 * The help centre: a short FAQ covering the questions families ask most —
 * creating and publishing a page, finding one, privacy, offerings, and cost.
 * Public and indexable, so a search for "how to create a memorial" can land
 * here.
 */
export default async function HelpPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("help");
  const guide = await getTranslations("obituaryGuide");

  return (
    <main id="main" className="container section">
      <div className="helpPage stack-lg measure">
        <header className="stack">
          <h1>{t("title")}</h1>
          <p className="lede">{t("intro")}</p>
        </header>

        <div className="faqList stack-lg">
          {FAQ_ITEMS.map((i) => (
            <section className="faqItem stack" key={i}>
              <h2 className="faqQuestion">{t(`q${i}`)}</h2>
              <p className="faqAnswer">{t(`a${i}`)}</p>
            </section>
          ))}
        </div>

        <p className="faqAnswer">
          <Link href={`/${locale}/obituary/guide`}>{guide("title")} →</Link>
        </p>

        <p>
          <Link
            className="button buttonQuiet buttonCompact"
            href={`/${locale}/contact`}
          >
            {t("contactCta")}
          </Link>
        </p>
      </div>
    </main>
  );
}
