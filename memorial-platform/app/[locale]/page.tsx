import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

export default async function HomePage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const search = await getTranslations("search");

  return (
    <main id="main">
      <section className="container section stack-lg">
        <div className="stack measure">
          <h1 style={{ fontSize: "var(--text-hero)" }}>{t("title")}</h1>
          <p className="lede">{t("subtitle")}</p>
        </div>

        {/*
         * The search sits on the landing page rather than behind a link. Most
         * people arriving here were sent a name by someone else and are trying
         * to find one page, not to browse a product.
         */}
        <form
          className="searchForm"
          method="get"
          action={`/${locale}/search`}
          role="search"
        >
          <label className="field fieldWide">
            <span className="fieldLabel">{search("queryLabel")}</span>
            <input
              className="input"
              type="search"
              name="q"
              placeholder={search("queryPlaceholder")}
              maxLength={200}
            />
          </label>
          <div>
            <button className="button buttonPrimary" type="submit">
              {search("submit")}
            </button>
          </div>
        </form>

        <nav className="ritualChoices" aria-label={t("createMemorial")}>
          <Link className="button buttonQuiet" href={`/${locale}/memorials/new`}>
            {t("createMemorial")}
          </Link>
          <Link className="button buttonQuiet" href={`/${locale}/search`}>
            {t("findMemorial")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
