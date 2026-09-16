import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";
import { currentActor } from "@/modules/auth/current-user";
import { loadProfile } from "@/modules/identity/profile";
import { loadAccountInfo } from "@/modules/identity/account";
import { AccountPage } from "./account-page";
import { AccountFinance } from "./account-finance";
import { MentionPrompt } from "../mention-prompt";
import { KinClaimPrompt } from "../kin-claim-prompt";
import { AvatarEditor } from "./avatar-editor";
import { loadAvatar } from "@/modules/identity/avatar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AccountRoute(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("account");
  const nav = await getTranslations("nav");
  const actor = await currentActor();

  if (!actor.userId) {
    return (
      <main id="main" className="container section measure stack">
        <h1>{t("title")}</h1>
        <p className="lede">{t("signInFirst")}</p>
        <div>
          <Link
            className="button buttonPrimary"
            href={`/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/account`)}`}
          >
            {nav("signIn")}
          </Link>
        </div>
      </main>
    );
  }

  const [profile, accountInfo, avatar] = await Promise.all([
    loadProfile(actor.userId),
    loadAccountInfo(actor.userId),
    loadAvatar(actor.userId),
  ]);

  const safeProfile = profile ?? {
    fullName: null,
    gender: null,
    birthDate: null,
    birthplace: null,
    nameVisibility: null,
  };

  return (
    <main id="main" className="container section stack-lg">
      <MentionPrompt
        userId={actor.userId}
        fullName={safeProfile.fullName}
        locale={locale}
      />
      <KinClaimPrompt fullName={safeProfile.fullName} locale={locale} />
      <AvatarEditor initial={avatar} />
      <AccountPage
        profile={safeProfile}
        email={accountInfo?.email ?? null}
        phone={accountInfo?.phone ?? null}
        providers={accountInfo?.providers ?? []}
        createdAt={accountInfo?.createdAt.toISOString() ?? ""}
        locale={locale}
      />
      <AccountFinance userId={actor.userId} locale={locale} />
    </main>
  );
}
