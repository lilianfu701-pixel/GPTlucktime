import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { env } from "@/lib/env";
import { normalizeLocale } from "@/lib/locale";
import { currentActor } from "@/modules/auth/current-user";
import {
  publicVisitorStories,
  publishedBiography,
} from "@/modules/memorials/content-service";
import { lifeSpan, loadMemorialDetail } from "@/modules/memorials/detail";
import { memorialUrl, robotsFor } from "@/modules/memorials/seo";
import { offerableRituals } from "@/modules/religion/memorial-settings";
import { OfferRitual } from "./offer-ritual";
import { PublishPanel } from "./publish-panel";

export const dynamic = "force-dynamic";

/*
 * Memoized for the request. `generateMetadata` and the page body both need the
 * memorial, and without this the access check and the read would run twice for
 * every visit.
 */
const load = cache(async (slug: string) => {
  const actor = await currentActor();
  return loadMemorialDetail(slug, actor);
});

export async function generateMetadata(props: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await props.params;
  const result = await load(slug);

  // A denied page gets no title of its own. Putting the name in the tab, or in
  // an OpenGraph card, would publish the fact the family withheld — the page
  // body refuses correctly and the metadata would leak around it.
  if (!result.ok) {
    return { robots: { index: false, follow: false } };
  }

  const { detail } = result;
  // The real status, not an assumed one: a draft is visible to its owner, and
  // an owner's browser is as capable of being a crawler's referrer as anyone's.
  const robots = robotsFor({
    slug: detail.slug,
    visibility: detail.visibility,
    status: detail.status,
    searchEngineIndexable: detail.searchEngineIndexable,
    availableLocales: [locale],
  });

  const span = lifeSpan(detail);
  // Bare years in the title. The approximation marker belongs to page copy,
  // and a browser tab is not the place to explain it.
  const years = [span.birth?.year, span.death?.year].filter(Boolean).join(" – ");

  return {
    title: years ? `${detail.primaryName} (${years})` : detail.primaryName,
    robots,
    alternates: {
      canonical: memorialUrl({
        appUrl: env().APP_URL,
        locale,
        slug: detail.slug,
      }),
    },
  };
}

export default async function MemorialPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const result = await load(slug);

  if (!result.ok) {
    if (result.reason === "MERGED") {
      // A link a family put in a death notice years ago has to keep working.
      if (result.redirectSlug) {
        redirect(`/${locale}/memorials/${result.redirectSlug}`);
      }
      notFound();
    }

    if (result.reason === "INVITATION_REQUIRED") {
      return (
        <main id="main" className="container section measure stack">
          <h1>{t("invitationRequiredTitle")}</h1>
          <p className="lede">{t("invitationRequiredBody")}</p>
        </main>
      );
    }

    if (result.reason === "GONE") {
      return (
        <main id="main" className="container section measure stack">
          <h1>{t("unavailableTitle")}</h1>
          <p className="lede">{t("unavailableBody")}</p>
        </main>
      );
    }

    // NOT_FOUND and FORBIDDEN are both a 404. Answering 403 would confirm that
    // a memorial for a named person exists here, which is the one fact an
    // invite-only family chose to keep.
    notFound();
  }

  const { detail } = result;
  const span = lifeSpan(detail);

  const [biography, stories, rituals] = await Promise.all([
    publishedBiography(detail.memorialId),
    publicVisitorStories(detail.memorialId),
    offerableRituals(detail.memorialId, normalizeLocale(locale)),
  ]);

  /*
   * An observance with no reviewed wording in this language is not offered.
   * Better to show one fewer control than to put an English ritual name on a
   * page a family is reading in their own language.
   */
  const offerable = rituals.filter((ritual) => ritual.name !== null);

  return (
    <main id="main">
      <article className="container section stack-lg">
        <header className="stack">
          {/*
           * Offered only to someone who can act on it. A visitor seeing a
           * "manage" link they cannot use would be told the family's roles
           * exist, and would waste a click finding out they are not one.
           */}
          {detail.viewerRole !== "public_visitor" &&
          detail.viewerRole !== "invited_visitor" ? (
            <p>
              <Link
                className="button buttonQuiet"
                href={`/${locale}/memorials/${detail.slug}/manage`}
              >
                {t("manageLink")}
              </Link>
            </p>
          ) : null}

          {/*
           * A draft is only ever reachable by the family, so this panel does
           * not need its own permission check — but publishing does, and the
           * endpoint it posts to keeps that with the owner.
           */}
          {detail.status === "draft" ? (
            <PublishPanel
              memorialId={detail.memorialId}
              willBeIndexed={
                detail.visibility === "public" && detail.searchEngineIndexable
              }
            />
          ) : null}

          {detail.status === "published" && detail.visibility === "unlisted" ? (
            <p className="notice">{t("privateNotice")}</p>
          ) : null}

          <h1>{detail.primaryName}</h1>

          {span.birth || span.death ? (
            <p className="lede">
              {span.birth ? (
                <span>
                  <span className="visuallyHidden">{t("bornLabel")} </span>
                  {span.birth.approximate
                    ? t("approximateYear", { year: span.birth.year })
                    : span.birth.year}
                </span>
              ) : null}
              {span.birth && span.death ? " – " : null}
              {span.death ? (
                <span>
                  <span className="visuallyHidden">{t("diedLabel")} </span>
                  {span.death.approximate
                    ? t("approximateYear", { year: span.death.year })
                    : span.death.year}
                </span>
              ) : null}
            </p>
          ) : null}

          {detail.alternateNames.length > 0 ? (
            <p className="muted">
              <span className="eyebrow">{t("alsoKnownAs")}</span>{" "}
              {detail.alternateNames.map((name) => name.value).join(" · ")}
            </p>
          ) : null}
        </header>

        <section className="stack measure">
          <h2>{t("lifeStory")}</h2>
          {biography ? (
            <div className="stack">
              {biography.title ? <h3>{biography.title}</h3> : null}
              {/*
               * Split into paragraphs rather than injected as markup. A family
               * writes prose here, and nothing a visitor or an editor typed may
               * become HTML on a page other people open.
               */}
              {biography.body
                .split(/\n{2,}/)
                .map((paragraph) => paragraph.trim())
                .filter((paragraph) => paragraph.length > 0)
                .map((paragraph, index) => (
                  <p key={`${biography.versionId}-${index}`}>{paragraph}</p>
                ))}
            </div>
          ) : (
            <p className="muted">{t("noLifeStoryYet")}</p>
          )}
        </section>

        <section className="stack">
          <h2>{t("waysToRemember")}</h2>
          {offerable.length > 0 ? (
            <OfferRitual
              memorialId={detail.memorialId}
              locale={normalizeLocale(locale)}
              rituals={offerable.map((ritual) => ({
                ritualVersionId: ritual.ritualVersionId,
                name: ritual.name,
                allowAnonymous: ritual.allowAnonymous,
                allowMessage: ritual.allowMessage,
                moderationMode: ritual.moderationMode,
              }))}
            />
          ) : (
            <p className="muted">{t("noRitualsOffered")}</p>
          )}
        </section>

        {stories.length > 0 ? (
          <section className="stack measure">
            <h2>{t("storiesFromVisitors")}</h2>
            {stories.map((story) => (
              <div className="card stack" key={story.id}>
                {story.title ? <h3>{story.title}</h3> : null}
                <p>{story.body}</p>
              </div>
            ))}
          </section>
        ) : null}
      </article>
    </main>
  );
}
