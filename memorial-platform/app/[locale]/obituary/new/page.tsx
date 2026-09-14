import { and, desc, eq, isNull } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Metadata } from "next";
import { db } from "@/db/client";
import { memorialNames, memorials } from "@/db/schema";
import { currentActor } from "@/modules/auth/current-user";
import { ObituaryNewForm } from "./obituary-new-form";

export const dynamic = "force-dynamic";

/** A private authoring page — never indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function PublishObituaryPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ memorial?: string }>;
}) {
  const { locale } = await props.params;
  const { memorial: preselectSlug } = await props.searchParams;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const nav = await getTranslations("nav");
  const guide = await getTranslations("obituaryGuide");
  const actor = await currentActor();

  if (!actor.userId) {
    return (
      <main id="main" className="container section measure stack">
        <h1>{t("obituaryPublishTitle")}</h1>
        <p className="lede">{t("signInToCreate")}</p>
        <div>
          <Link
            className="button buttonPrimary"
            href={`/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/obituary/new`)}`}
          >
            {nav("signIn")}
          </Link>
        </div>
      </main>
    );
  }

  // The memorials this person owns, with their current obituary, so an existing
  // one can be picked and its obituary pre-filled for editing.
  const rows = await db()
    .select({
      id: memorials.id,
      slug: memorials.slug,
      name: memorialNames.value,
      body: memorials.obituaryBody,
      nativePlace: memorials.obituaryNativePlace,
      service: memorials.obituaryService,
      survivors: memorials.obituarySurvivors,
      age: memorials.obituaryAge,
    })
    .from(memorials)
    .leftJoin(
      memorialNames,
      and(
        eq(memorialNames.memorialId, memorials.id),
        eq(memorialNames.type, "primary"),
      ),
    )
    .where(
      and(
        eq(memorials.ownerUserId, actor.userId),
        isNull(memorials.deletionRequestedAt),
      ),
    )
    .orderBy(desc(memorials.createdAt));

  const list = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name ?? "",
    obituary: {
      body: r.body,
      nativePlace: r.nativePlace,
      service: r.service,
      survivors: r.survivors,
      age: r.age,
    },
  }));

  return (
    <main id="main" className="container section stack">
      <header className="stack measure">
        <h1>{t("obituaryPublishTitle")}</h1>
        <p className="lede">{t("obituaryStandaloneIntro")}</p>
        <p className="muted" style={{ margin: 0 }}>
          <Link href={`/${locale}/obituary/guide`}>{guide("title")} →</Link>
        </p>
      </header>
      <ObituaryNewForm
        locale={locale}
        memorials={list}
        {...(preselectSlug ? { preselectSlug } : {})}
      />
    </main>
  );
}
