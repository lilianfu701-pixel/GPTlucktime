import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { flags } from "@/lib/feature-flags";
import { currentActor } from "@/modules/auth/current-user";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * The channels are decided on the server. Phase one keeps phone sign-in built
 * and tested but hidden, and hiding it with CSS or a client-side check would
 * leave the markup in the page for anyone who opened the source.
 */
export default async function SignInPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await props.params;
  const { next } = await props.searchParams;
  setRequestLocale(locale);

  // Carried onto the OAuth link so a social login returns to where the visitor
  // was (e.g. a memorial they were making an offering on). Only same-origin.
  const nextRaw = (next ?? "").trim();
  const safeNextParam =
    nextRaw.startsWith("/") && !nextRaw.startsWith("//")
      ? `&next=${encodeURIComponent(nextRaw)}`
      : "";

  // Someone already signed in has nothing to do here, and showing them a form
  // that would replace their session is a way to lose one by accident.
  const actor = await currentActor();
  if (actor.userId) {
    redirect(`/${locale}`);
  }

  const t = await getTranslations("auth");
  const { phoneAuthEnabled, oauthGoogleEnabled, oauthAppleEnabled } = flags();
  // Google is unreachable in mainland China — hide it on the Simplified-Chinese
  // sign-in page.
  const showGoogle = oauthGoogleEnabled && locale !== "zh-CN";

  return (
    <main id="main" className="container section stack-lg">
      <header className="stack measure">
        <h1>{t("signInTitle")}</h1>
        <p className="lede">{t("signInSubtitle")}</p>
      </header>

      {/* `useSearchParams` needs a boundary it can suspend at. */}
      <Suspense>
        <SignInForm locale={locale} phoneAuthEnabled={phoneAuthEnabled} />
      </Suspense>

      {showGoogle || oauthAppleEnabled ? (
        <div className="stack measure">
          <p className="muted">{t("alternativeDivider")}</p>
          <div className="ritualChoices">
            {showGoogle ? (
              <a
                className="button buttonQuiet"
                href={`/api/auth/oauth/google?locale=${locale}${safeNextParam}`}
              >
                {t("continueWithGoogle")}
              </a>
            ) : null}
            {oauthAppleEnabled ? (
              <a
                className="button buttonQuiet"
                href={`/api/auth/oauth/apple?locale=${locale}${safeNextParam}`}
              >
                {t("continueWithApple")}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
