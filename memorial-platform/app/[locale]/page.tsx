import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { oauthGoogleEnabledSafe } from "@/lib/feature-flags";
import { HomeSignIn } from "./home-sign-in";
import { HomeShowcase } from "./home-showcase";

// Public marketing page with no per-user server content — statically rendered
// and edge-cached so China visitors get it from a nearby PoP rather than a
// fresh US render. The sign-in widget self-gates on the client.
export const revalidate = 3600;

export async function generateMetadata(props: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("homeTitle"),
    description: t("homeDescription"),
  };
}

const languageGreetings = [
  { locale: "en", label: "English", text: "Every life deserves to be remembered." },
  { locale: "zh-CN", label: "简体中文", text: "每一个生命都值得被纪念。" },
  { locale: "zh-TW", label: "繁體中文", text: "每一個生命都值得被紀念。" },
  { locale: "zh-HK", label: "粵語", text: "每一個生命都值得被紀念。" },
  { locale: "es", label: "Español", text: "Cada vida merece ser recordada." },
  { locale: "pt-BR", label: "Português (BR)", text: "Toda vida merece ser lembrada." },
  { locale: "pt-PT", label: "Português (PT)", text: "Cada vida merece ser recordada." },
  { locale: "fr", label: "Français", text: "Chaque vie mérite qu'on s'en souvienne." },
  { locale: "de", label: "Deutsch", text: "Jedes Leben verdient es, in Erinnerung zu bleiben." },
  { locale: "ar", label: "العربية", text: "كل حياة تستحق أن تُذكر." },
  { locale: "ja", label: "日本語", text: "すべての命は、記憶される価値がある。" },
  { locale: "ru", label: "Русский", text: "Каждая жизнь достойна памяти." },
  { locale: "id", label: "Indonesia", text: "Setiap kehidupan layak untuk dikenang." },
  { locale: "vi", label: "Tiếng Việt", text: "Mỗi cuộc đời đều xứng đáng được tưởng nhớ." },
  { locale: "ko", label: "한국어", text: "모든 삶은 기억될 가치가 있습니다." },
];

export default async function HomePage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const search = await getTranslations("search");
  const oauthGoogleEnabled = oauthGoogleEnabledSafe();

  return (
    <main id="main">
      <section className="heroSection">
        <div className="container heroContent stack-lg">
          <span className="eyebrow">{t("heroEyebrow")}</span>
          <div className="stack measure">
            <h1 style={{ fontSize: "var(--text-hero)" }}>{t("title")}</h1>
            <p className="lede">{t("subtitle")}</p>
          </div>

          <form
            className="heroSearchForm"
            method="get"
            action={`/${locale}/search`}
            role="search"
          >
            <label className="field fieldWide">
              <span className="fieldLabel">{search("nameOrNumberLabel")}</span>
              <input
                className="input"
                type="search"
                name="q"
                placeholder={search("nameOrNumberPlaceholder")}
                maxLength={200}
              />
            </label>
            <button className="button buttonPrimary" type="submit">
              {search("submit")}
            </button>
          </form>

          <nav className="heroActions" aria-label={t("createMemorial")}>
            <Link
              className="button buttonPrimary"
              href={`/${locale}/obituary/new`}
            >
              {t("publishObituary")}
            </Link>
            <Link
              className="button buttonPrimary"
              href={`/${locale}/memorials/new`}
            >
              {t("createMemorial")}
            </Link>
            <Link className="button buttonQuiet" href={`/${locale}/search`}>
              {t("findMemorial")}
            </Link>
          </nav>
        </div>

        <div className="heroWave" aria-hidden="true">
          <svg
            viewBox="0 0 1440 80"
            preserveAspectRatio="none"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M0 40C240 65 480 15 720 40C960 65 1200 20 1440 35V80H0Z"
              fill="var(--paper)"
            />
          </svg>
        </div>
      </section>

      {/* Client-fetched from /api/showcase so a just-published memorial appears
          within minutes, without waiting for the edge-cached homepage HTML. */}
      <HomeShowcase locale={locale} />

      <section className="section">
        <div className="container stack-lg textCenter">
          <h2>{t("featuresTitle")}</h2>
          <div className="featureGrid">
            <div className="featureCard">
              <div className="featureIcon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2C8 3 5 7 4 11c-1 4 1 8 4 10 1.5 1.2 3 2 4 2s2.5-.8 4-2c3-2 5-6 4-10-1-4-4-8-8-9z" />
                  <path d="M12 6v14" />
                  <path d="M8.5 10c1.5 1 2.5 2 3.5 2" />
                  <path d="M15.5 10c-1.5 1-2.5 2-3.5 2" />
                </svg>
              </div>
              <h3>{t("featureRememberTitle")}</h3>
              <p>{t("featureRememberDesc")}</p>
            </div>

            <div className="featureCard">
              <div className="featureIcon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z" />
                </svg>
              </div>
              <h3>{t("featureFindTitle")}</h3>
              <p>{t("featureFindDesc")}</p>
            </div>

            <div className="featureCard">
              <div className="featureIcon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="9" cy="7" r="3" />
                  <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
                  <circle cx="17.5" cy="9" r="2.5" />
                  <path d="M21 21v-1.5c0-1.4-.8-2.6-2-3.2" />
                </svg>
              </div>
              <h3>{t("featureShareTitle")}</h3>
              <p>{t("featureShareDesc")}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container stack-lg textCenter">
          <span className="eyebrow">{t("languagesTitle")}</span>
          <div className="languageWall">
            {languageGreetings.map((lang) => (
              <Link
                key={lang.locale}
                className="languagePill"
                href={`/${lang.locale}`}
              >
                <span className="languagePillName">{lang.label}</span>
                <span className="muted">{lang.text}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="ctaSection section">
        <div className="container stack textCenter">
          <h2>{t("ctaTitle")}</h2>
          <p className="lede measure" style={{ marginInline: "auto" }}>
            {t("ctaDesc")}
          </p>
          <div>
            <Link
              className="button buttonPrimary"
              href={`/${locale}/memorials/new`}
            >
              {t("createMemorial")}
            </Link>
          </div>

          <Suspense>
            {/* Google is unreachable in mainland China — no Google sign-in on
                the Simplified-Chinese homepage. */}
            <HomeSignIn
              locale={locale}
              googleEnabled={oauthGoogleEnabled && locale !== "zh-CN"}
            />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
