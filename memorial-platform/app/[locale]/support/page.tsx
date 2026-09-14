import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";
import { normalizeLocale } from "@/lib/locale";
import { SupportForm } from "./support-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "platformSupport" });
  return {
    title: t("title"),
    description: t("lede"),
    // Useful to visitors, but not a page search engines need to rank.
    robots: { index: false, follow: true },
  };
}

/**
 * "资助追思网平台" — a gift to the platform (not to any family), reached from the
 * footer on every page. Custom amount, ¥9.9 floor, paid via PayPal. Shows a
 * thank-you when the payer returns from a completed payment.
 */
export default async function SupportPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const normalized = normalizeLocale(locale);
  const { state } = await props.searchParams;
  const t = await getTranslations("platformSupport");

  const thanked = state === "thanks";

  return (
    <main id="main" className="container section">
      <div className="supportLayout stack-lg measure">
        <header className="stack">
          <h1>{t("title")}</h1>
        </header>

        {thanked ? (
          <div className="notice stack" role="status">
            <strong>{t("thanksTitle")}</strong>
            <span>{t("thanksBody")}</span>
          </div>
        ) : null}
        {state === "cancel" ? (
          <p className="muted">{t("cancel")}</p>
        ) : null}

        <SupportForm locale={normalized} />

        <p>
          <Link className="linkButton" href={`/${locale}`}>
            ← {t("backHome")}
          </Link>
        </p>
      </div>
    </main>
  );
}
