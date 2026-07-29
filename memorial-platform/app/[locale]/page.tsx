import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

export default async function HomePage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const nav = await getTranslations("a11y");

  return (
    <>
      <a href="#main">{nav("skipToContent")}</a>
      <main id="main">
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <nav>
          <Link href={`/${locale}/memorials/new`}>{t("createMemorial")}</Link>
          <Link href={`/${locale}/search`}>{t("findMemorial")}</Link>
        </nav>
      </main>
    </>
  );
}
