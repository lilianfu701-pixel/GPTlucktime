import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { flags } from "@/lib/feature-flags";
import { DEFAULT_LIMIT, searchMemorials } from "@/modules/search/query";

export const dynamic = "force-dynamic";

type SearchParams = {
  q?: string;
  birthYear?: string;
  deathYear?: string;
  country?: string;
};

/** Keeps a stray or malformed year out of the query without failing the page. */
function yearFrom(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1583 && parsed <= 2200
    ? parsed
    : undefined;
}

export default async function SearchPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  if (!flags().publicSearchEnabled) {
    notFound();
  }

  const t = await getTranslations("search");
  const query = await props.searchParams;

  const criteria = {
    q: query.q?.trim() || undefined,
    birthYear: yearFrom(query.birthYear),
    deathYear: yearFrom(query.deathYear),
    country: query.country?.trim().toUpperCase() || undefined,
  };

  const hasCriteria = Object.values(criteria).some(
    (value) => value !== undefined,
  );

  const result = hasCriteria
    ? await searchMemorials({ ...criteria, limit: DEFAULT_LIMIT })
    : null;

  return (
    <main id="main" className="container section stack-lg">
      <header className="stack measure">
        <h1>{t("title")}</h1>
      </header>

      {/*
       * A GET form. The query belongs in the URL so a result can be sent to a
       * relative who is also looking, and so the back button behaves the way
       * someone searching through several spellings of a name expects.
       */}
      <form className="searchForm" method="get" role="search">
        <label className="field fieldWide">
          <span className="fieldLabel">{t("queryLabel")}</span>
          <input
            className="input"
            type="search"
            name="q"
            defaultValue={criteria.q ?? ""}
            placeholder={t("queryPlaceholder")}
            maxLength={200}
          />
        </label>

        <label className="field">
          <span className="fieldLabel">{t("birthYearLabel")}</span>
          <input
            className="input"
            type="number"
            name="birthYear"
            inputMode="numeric"
            min={1583}
            max={2200}
            defaultValue={criteria.birthYear ?? ""}
          />
        </label>

        <label className="field">
          <span className="fieldLabel">{t("deathYearLabel")}</span>
          <input
            className="input"
            type="number"
            name="deathYear"
            inputMode="numeric"
            min={1583}
            max={2200}
            defaultValue={criteria.deathYear ?? ""}
          />
        </label>

        <label className="field">
          <span className="fieldLabel">{t("countryLabel")}</span>
          <input
            className="input"
            type="text"
            name="country"
            maxLength={2}
            defaultValue={criteria.country ?? ""}
            placeholder="US"
          />
        </label>

        <div>
          <button className="button buttonPrimary" type="submit">
            {t("submit")}
          </button>
        </div>
      </form>

      <section className="stack" aria-live="polite">
        {!hasCriteria ? (
          <p className="muted">{t("startPrompt")}</p>
        ) : result && !result.ok ? (
          <p className="muted">{t("noResults")}</p>
        ) : result?.ok && result.value.hits.length === 0 ? (
          <p className="muted">{t("noResults")}</p>
        ) : result?.ok ? (
          <>
            <h2 className="eyebrow">{t("resultsHeading")}</h2>
            <ul className="resultList">
              {result.value.hits.map((hit) => {
                const years = [hit.birthYear, hit.deathYear]
                  .filter((year) => year !== null)
                  .join(" – ");

                return (
                  <li className="resultItem" key={hit.memorialId}>
                    <Link
                      className="resultName"
                      href={`/${locale}/memorials/${hit.slug}`}
                    >
                      {hit.primaryName}
                    </Link>
                    {years ? <p className="muted">{years}</p> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </section>
    </main>
  );
}
