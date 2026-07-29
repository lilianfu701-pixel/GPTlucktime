import { getTranslations, setRequestLocale } from "next-intl/server";
import { flags } from "@/lib/feature-flags";

/**
 * Sign-in.
 *
 * The phone fields are decided on the server. Phase one keeps that path built
 * and tested but hidden, and hiding it with CSS or a client-side check would
 * leave the markup in the page for anyone who opened the source.
 */
export default async function SignInPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("auth");
  const a11y = await getTranslations("a11y");
  const { phoneAuthEnabled, oauthGoogleEnabled, oauthAppleEnabled } = flags();

  return (
    <>
      <a href="#main">{a11y("skipToContent")}</a>
      <main id="main">
        <h1>{t("signInTitle")}</h1>
        <p>{t("signInSubtitle")}</p>

        <form method="post" action="/api/auth/email/request">
          <label htmlFor="email">{t("emailLabel")}</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder={t("emailPlaceholder")}
          />
          <button type="submit">{t("sendCode")}</button>
        </form>

        {phoneAuthEnabled ? (
          <form method="post" action="/api/auth/phone/request">
            <label htmlFor="region">{t("phoneRegionLabel")}</label>
            <input id="region" name="region" type="text" required maxLength={2} />
            <label htmlFor="phone">{t("phoneLabel")}</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              required
            />
            <button type="submit">{t("sendCode")}</button>
          </form>
        ) : null}

        {oauthGoogleEnabled || oauthAppleEnabled ? (
          <>
            <p>{t("alternativeDivider")}</p>
            {oauthGoogleEnabled ? (
              <a href={`/api/auth/oauth/google?locale=${locale}`}>
                {t("continueWithGoogle")}
              </a>
            ) : null}
            {oauthAppleEnabled ? (
              <a href={`/api/auth/oauth/apple?locale=${locale}`}>
                {t("continueWithApple")}
              </a>
            ) : null}
          </>
        ) : null}
      </main>
    </>
  );
}
