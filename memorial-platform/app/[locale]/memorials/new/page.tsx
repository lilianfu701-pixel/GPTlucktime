import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { currentActor } from "@/modules/auth/current-user";
import { CreateMemorialForm } from "./create-form";

export const dynamic = "force-dynamic";

/**
 * Creating a memorial.
 *
 * The sign-in check is on the server. Rendering the form to a signed-out
 * visitor and refusing at submit would mean someone types their mother's name
 * and dates, then loses them to a redirect.
 */
export default async function NewMemorialPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const nav = await getTranslations("nav");
  const actor = await currentActor();

  if (!actor.userId) {
    return (
      <main id="main" className="container section measure stack">
        <h1>{t("createTitle")}</h1>
        <p className="lede">{t("signInToCreate")}</p>
        <div>
          <Link className="button buttonPrimary" href={`/${locale}/sign-in`}>
            {nav("signIn")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="container section stack-lg">
      <header className="stack measure">
        <h1>{t("createTitle")}</h1>
        <p className="lede">{t("relationshipHelp")}</p>
      </header>
      <CreateMemorialForm locale={locale} />
    </main>
  );
}
