import { and, asc, eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { db } from "@/db/client";
import {
  memorialBookmarks,
  memorialLocations,
  memorialRelatives,
  memorials,
  users,
} from "@/db/schema";
import { countryName } from "@/lib/countries";
import { env, siteUrl } from "@/lib/env";
import { currentActor } from "@/modules/auth/current-user";
import {
  publicVisitorStories,
  publishedBiography,
} from "@/modules/memorials/content-service";
import { lifeSpan, loadMemorialDetail } from "@/modules/memorials/detail";
import { portraitCreditForMemorial, portraitsBySlug } from "@/modules/media/service";
import { avatarsForRelativeNames } from "@/modules/identity/avatar";
import { memorialUrl, robotsFor } from "@/modules/memorials/seo";
import {
  getMemorialAdminName,
  myTakeoverRequest,
  TAKEOVER_GRACE_DAYS,
} from "@/modules/memorials/ownership";
import { TakeoverPanel } from "./takeover-panel";
import { ClaimBanner } from "./claim-banner";
import { AdminReclaim } from "./admin-reclaim";
import { offeringSummary } from "@/modules/offerings/display";
import { listPublicChapters } from "@/modules/memorials/life-chapters";
import { getDisposition } from "@/modules/memorials/disposition";
import { DispositionCard } from "./disposition-card";
import { DEFAULT_LOCALE, LAUNCH_LOCALES } from "@/lib/locale";
import { BreadcrumbJsonLd, MemorialJsonLd } from "./memorial-jsonld";
import { familyViewForMemorial } from "@/modules/genealogy/family-view";
import { BookmarkButton } from "./bookmark-button";
import { FollowButton } from "./follow-button";
import { isFollowing } from "@/modules/reminders/follow";
import { ContactManager } from "./contact-manager";
import { FamilyTree } from "./family-tree";
import { Guestbook } from "./guestbook";
import { OfferingsAltar } from "./offerings-altar";
import { LifeChapters } from "./life-chapters";
import { Contributions } from "./contributions";
import {
  contributorStanding,
  listPublicContributions,
} from "@/modules/memorials/contributions";
import { PublishPanel } from "./publish-panel";
import { Share } from "./share";

/*
 * The creator declared the deceased's relationship to *them* ("the deceased is
 * your father/son/…"). The public line reads the other way — the creator's
 * relationship to the deceased — so each declared role maps to its inverse.
 * Genderless where the inverse is ambiguous (a father's memorial is kept by a
 * "child", not necessarily a son). No name is shown, only the relationship.
 */
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

  const appUrl = env().APP_URL;
  const indexable =
    detail.visibility === "public" &&
    detail.status === "published" &&
    detail.searchEngineIndexable;

  // Only advertise translations for a page Google may index; a private or
  // noindex page has no business linking language variants.
  const languages = indexable
    ? {
        ...Object.fromEntries(
          LAUNCH_LOCALES.map((l) => [
            l,
            memorialUrl({ appUrl, locale: l, slug: detail.slug }),
          ]),
        ),
        "x-default": memorialUrl({
          appUrl,
          locale: DEFAULT_LOCALE,
          slug: detail.slug,
        }),
      }
    : undefined;

  const title = years
    ? `${detail.primaryName} (${years})`
    : detail.primaryName;

  // A name-forward description so search engines index who this page is for.
  const tMeta = await getTranslations({ locale, namespace: "memorial" });
  const description = years
    ? tMeta("metaDescriptionYears", { name: detail.primaryName, years })
    : tMeta("metaDescription", { name: detail.primaryName });

  // The portrait, for social share cards (WeChat / X / Facebook) and search.
  // Point at the stable bytes route, never the signed storage URL — a crawler
  // fetches the card long after the page was rendered, so a five-minute
  // signature would be dead by then.
  let ogImage: string | undefined;
  if (indexable) {
    const portraits = await portraitsBySlug([detail.slug]);
    if (portraits.has(detail.slug)) {
      ogImage = `${appUrl.replace(/\/$/, "")}/api/portrait/${detail.slug}`;
    }
  }

  const canonical = memorialUrl({ appUrl, locale, slug: detail.slug });

  return {
    title,
    description,
    robots,
    alternates: {
      canonical,
      ...(languages ? { languages } : {}),
    },
    openGraph: {
      title,
      description,
      type: "profile",
      url: canonical,
      siteName: "missingu.org",
      // OG wants ll_TT (underscore); our locales are ll-TT.
      locale: locale.replace("-", "_"),
      ...(ogImage
        ? { images: [{ url: ogImage, alt: detail.primaryName }] }
        : {}),
    },
    twitter: {
      // A portrait reads better as a square thumbnail than a wide, face-cropping
      // banner, so this is a summary card rather than summary_large_image.
      card: "summary",
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  };
}

export default async function MemorialPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const nav = await getTranslations("nav");
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

  // Dates shown to the precision the family actually recorded: a full date to
  // the day when known, otherwise the year — never a placeholder day.
  const fullDate = (
    value: string | null,
    precision: (typeof detail)["birthDatePrecision"],
  ): string | null => {
    if (!value || precision === "unknown") return null;
    if (precision === "year" || precision === "approximate") {
      return value.slice(0, 4);
    }
    const dt = new Date(`${value}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return value.slice(0, 4);
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      ...(precision === "day" ? { day: "numeric" } : {}),
    }).format(dt);
  };
  const birthText = fullDate(detail.birthDate, detail.birthDatePrecision);
  const deathText = fullDate(detail.deathDate, detail.deathDatePrecision);

  // A member of this memorial: sees family-scoped messages and moderates.
  const isFamily =
    detail.viewerRole !== "public_visitor" &&
    detail.viewerRole !== "invited_visitor";
  const viewer = await currentActor();

  const [
    biography,
    stories,
    relatives,
    locations,
    offerings,
    chapters,
    contributions,
  ] = await Promise.all([
      publishedBiography(detail.memorialId),
      publicVisitorStories(detail.memorialId, {
        userId: viewer.userId,
        isFamily,
      }),
      db()
        .select({
          id: memorialRelatives.id,
          name: memorialRelatives.name,
          relationshipToDeceased: memorialRelatives.relationshipToDeceased,
          isDeceased: memorialRelatives.isDeceased,
          showFullName: memorialRelatives.showFullName,
          nameVisibility: memorialRelatives.nameVisibility,
          displayOrder: memorialRelatives.displayOrder,
          coParentId: memorialRelatives.coParentId,
          spouseOfId: memorialRelatives.spouseOfId,
        })
        .from(memorialRelatives)
        .where(eq(memorialRelatives.memorialId, detail.memorialId))
        .orderBy(asc(memorialRelatives.displayOrder)),
      db()
        .select({
          kind: memorialLocations.kind,
          country: memorialLocations.country,
          region: memorialLocations.region,
        })
        .from(memorialLocations)
        .where(eq(memorialLocations.memorialId, detail.memorialId)),
      offeringSummary(detail.memorialId),
      listPublicChapters(detail.memorialId),
      listPublicContributions(detail.memorialId),
    ]);

  const disposition = await getDisposition(detail.memorialId);

  // Offering availability: a platform-stewarded page (awaiting a family claim)
  // closes the paid offerings, and the family may switch individual ones off.
  const [offeringFlags] = await db()
    .select({
      stewardedByAdminAt: memorials.stewardedByAdminAt,
      offeringsDisabled: memorials.offeringsDisabled,
      creationIdempotencyKey: memorials.creationIdempotencyKey,
    })
    .from(memorials)
    .where(eq(memorials.id, detail.memorialId));
  const awaitingClaim = Boolean(offeringFlags?.stewardedByAdminAt);
  const disabledSlugs = offeringFlags?.offeringsDisabled ?? [];
  // An imported page was built by the site from public data (Wikidata), which is
  // a different origin from a family-created page or an admin's hand-built one —
  // its claim notice says so.
  const importedSeed = Boolean(
    offeringFlags?.creationIdempotencyKey?.startsWith("import:"),
  );

  // The family tree, assembled from the registered relatives and any confirmed
  // links to other memorials. A year is only used when the date is real, not a
  // placeholder standing in for an unknown precision.
  const rootYear = (
    date: string | null,
    precision: (typeof detail)["birthDatePrecision"],
  ): number | null =>
    date && precision !== "unknown" ? Number.parseInt(date.slice(0, 4), 10) : null;
  // The page shows three generations — parents, this person's own, children.
  // Grandparents and beyond live on the full genealogy view.
  const compactRelatives = relatives.filter(
    (r) => !r.relationshipToDeceased.includes("grand"),
  );
  const familyView = await familyViewForMemorial(
    detail.memorialId,
    {
      name: detail.primaryName,
      birthYear: rootYear(detail.birthDate, detail.birthDatePrecision),
      deathYear: rootYear(detail.deathDate, detail.deathDatePrecision),
    },
    compactRelatives,
    { viewerLoggedIn: viewer.userId !== null, hiddenLabel: t("nameHiddenPlaceholder") },
  );

  // Portraits for relatives who have their own memorial, so the family chart
  // shows faces rather than initials.
  const treePortraits = familyView
    ? await portraitsBySlug([
        // The root's own slug is not carried in the tree, so add it here.
        detail.slug,
        ...familyView.tree.nodes
          .map((node) => ("memorialSlug" in node ? node.memorialSlug : null))
          .filter((slug): slug is string => Boolean(slug)),
      ])
    : new Map<string, string>();
  // The deceased's own portrait must show even when there is no family tree
  // (e.g. a page with no relatives, or a platform-created page awaiting a
  // claim). treePortraits only runs when a tree exists, so fall back to a
  // direct lookup for the root.
  const rootPortrait =
    treePortraits.get(detail.slug) ??
    (await portraitsBySlug([detail.slug])).get(detail.slug) ??
    null;
  // A photo credit for an imported 遗照 (author · licence · Commons); null for a
  // family's own upload.
  const portraitCredit = rootPortrait
    ? await portraitCreditForMemorial(detail.memorialId)
    : null;

  // A living relative who claimed their place and chose to appear shows their
  // own photograph, keyed by the name the memorial lists them under.
  const treeAvatars = familyView
    ? await avatarsForRelativeNames(detail.memorialId)
    : new Map<string, string>();

  // Whether this viewer is a verified friend/relative, so the contribution
  // form can invite them to post without review.
  const viewerStanding = await contributorStanding(
    viewer.userId,
    detail.memorialId,
  );

  // Whether this viewer has already kept this memorial.
  const viewerBookmarked = viewer.userId
    ? (
        await db()
          .select({ memorialId: memorialBookmarks.memorialId })
          .from(memorialBookmarks)
          .where(
            and(
              eq(memorialBookmarks.userId, viewer.userId),
              eq(memorialBookmarks.memorialId, detail.memorialId),
            ),
          )
      ).length > 0
    : false;

  // The signed-in visitor's own name, so lighting a candle can default to it.
  const viewerName = viewer.userId
    ? ((
        await db()
          .select({
            displayName: users.displayName,
            fullName: users.fullName,
          })
          .from(users)
          .where(eq(users.id, viewer.userId))
      )[0] ?? null)
    : null;
  const viewerDisplayName =
    viewerName?.displayName?.trim() || viewerName?.fullName?.trim() || null;

  const formatPlace = (loc: { country: string | null; region: string | null }) =>
    [loc.region, loc.country ? countryName(loc.country, locale) : ""]
      .map((part) => part?.trim())
      .filter((part) => part && part.length > 0)
      .join(" · ");

  const birthPlace = locations.find((loc) => loc.kind === "birth");
  const deathPlace = locations.find((loc) => loc.kind === "death");
  const birthPlaceText = birthPlace ? formatPlace(birthPlace) : "";
  const deathPlaceText = deathPlace ? formatPlace(deathPlace) : "";

  const canManage = isFamily;
  // Whether a non-family viewer follows this page (to receive its reminders).
  const viewerFollowing =
    !canManage && viewer.userId
      ? await isFollowing(detail.memorialId, viewer.userId)
      : false;
  // Who manages this page, and — for a signed-in visitor who does not — their
  // own standing takeover request, if any.
  const adminName = await getMemorialAdminName(detail.memorialId);
  const myTakeover =
    !canManage && viewer.userId
      ? await myTakeoverRequest(detail.memorialId, viewer.userId)
      : null;
  const showOwnerBar =
    detail.status === "draft" ||
    (detail.status === "published" && detail.visibility === "unlisted");

  // A platform super admin can reclaim management of any page they don't own —
  // but not a platform-stewarded seed, which the platform already holds on a
  // family's behalf and which shows its own "awaiting a claim" banner instead.
  const showAdminReclaim =
    viewer.platformRole === "super_admin" &&
    detail.viewerRole !== "owner" &&
    !awaitingClaim;

  // Structured data only for a page Google may index.
  const indexable =
    detail.visibility === "public" &&
    detail.status === "published" &&
    detail.searchEngineIndexable;
  const schemaDate = (
    value: string | null,
    precision: string,
  ): string | null => {
    if (!value || precision === "unknown") return null;
    if (precision === "day") return value.slice(0, 10);
    if (precision === "month") return value.slice(0, 7);
    return value.slice(0, 4);
  };
  // For the Person JSON-LD, advertise the stable bytes route rather than the
  // signed storage URL: a signed URL carries an expiry and would 403 by the time
  // a search engine fetches it. The route resolves a fresh image per request.
  const schemaImage = rootPortrait
    ? `${siteUrl().replace(/\/$/, "")}/api/portrait/${detail.slug}`
    : null;
  const schemaDescription = biography?.body
    ? biography.body.replace(/\s+/g, " ").trim().slice(0, 300)
    : null;

  return (
    <main id="main">
      {indexable ? (
        <>
          <MemorialJsonLd
            url={memorialUrl({ appUrl: siteUrl(), locale, slug: detail.slug })}
            name={detail.primaryName}
            image={schemaImage}
            description={schemaDescription}
            birthDate={schemaDate(detail.birthDate, detail.birthDatePrecision)}
            deathDate={schemaDate(detail.deathDate, detail.deathDatePrecision)}
            birthPlace={birthPlaceText || null}
            deathPlace={deathPlaceText || null}
          />
          <BreadcrumbJsonLd
            items={[
              { name: nav("home"), url: `${siteUrl()}/${locale}` },
              { name: nav("search"), url: `${siteUrl()}/${locale}/search` },
              {
                name: detail.primaryName,
                url: memorialUrl({ appUrl: siteUrl(), locale, slug: detail.slug }),
              },
            ]}
          />
        </>
      ) : null}
      <article className="container section memorialView">
        {/* A platform-stewarded page (built from an obituary, awaiting a family
         * claim) leads with a prominent notice and a claim entry, so a relative
         * arriving from a search sees straight away that they can take it on. */}
        {awaitingClaim && !canManage ? (
          <ClaimBanner
            memorialId={detail.memorialId}
            imported={importedSeed}
            signedIn={viewer.userId !== null}
            signInHref={`/${locale}/sign-in?next=${encodeURIComponent(
              `/${locale}/memorials/${detail.slug}`,
            )}`}
            requestStatus={
              myTakeover &&
              (myTakeover.status === "pending" ||
                myTakeover.status === "escalated" ||
                myTakeover.status === "declined")
                ? myTakeover.status
                : null
            }
          />
        ) : null}
        {showAdminReclaim ? (
          <div className="memorialOwnerBar">
            <AdminReclaim memorialId={detail.memorialId} />
          </div>
        ) : null}
        {showOwnerBar ? (
          <div className="memorialOwnerBar">
            {/*
             * A draft is only ever reachable by the family, so this panel does
             * not need its own permission check — but publishing does, and the
             * endpoint it posts to keeps that with the owner.
             */}
            {detail.status === "draft" ? (
              <PublishPanel
                memorialId={detail.memorialId}
                manageHref={`/${locale}/memorials/${detail.slug}/manage`}
              />
            ) : null}

            {detail.status === "published" &&
            detail.visibility === "unlisted" ? (
              <p className="notice">{t("privateNotice")}</p>
            ) : null}
          </div>
        ) : null}

        {/* The altar leads the page: the portrait, flanked by wreaths, with the
         * censer and candles below. The deceased's details follow beneath it. */}
        <OfferingsAltar
          memorialId={detail.memorialId}
          summary={offerings}
          isLoggedIn={viewer.userId !== null}
          locale={locale}
          viewerName={viewerDisplayName}
          portrait={rootPortrait}
          portraitCredit={portraitCredit}
          personName={detail.primaryName}
          paymentEnabled={Boolean(
            process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET,
          )}
          awaitingClaim={awaitingClaim}
          disabledSlugs={disabledSlugs}
          details={
            <header className="memorialHead">
          {/* Name and the names the person was known by, on one line. The
           * primary name is the page's H1 — the strongest signal to search
           * engines about who this page is for. */}
          <div className="memorialNames">
            <h1 className="memorialName">{detail.primaryName}</h1>
            {detail.alternateNames.map((name, index) => (
              <span key={`${name.type}-${index}`} className="memorialAlias">
                <span className="memorialAliasType">
                  {t(`nameType_${name.type}`)}
                </span>
                {name.value}
              </span>
            ))}
          </div>

          {/* Birth and death, side by side. */}
          <div className="memorialLifeline memorialLifelineRow">
            {birthText ? (
              <p className="memorialLifelineEntry">
                <span className="memorialLifelineMarker" aria-hidden="true">★</span>
                {span.birth?.approximate
                  ? t("approximateYear", { year: birthText })
                  : birthText}
                {birthPlaceText ? (
                  <span className="memorialLifelinePlace">
                    {t("bornIn", { place: birthPlaceText })}
                  </span>
                ) : null}
              </p>
            ) : null}
            {deathText ? (
              <p className="memorialLifelineEntry">
                <span className="memorialLifelineMarker" aria-hidden="true">†</span>
                {span.death?.approximate
                  ? t("approximateYear", { year: deathText })
                  : deathText}
                {deathPlaceText ? (
                  <span className="memorialLifelinePlace">
                    {t("diedIn", { place: deathPlaceText })}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>

          {/* Three functions: contact the manager, bookmark, share. The contact
           * button is hidden for a manager — you cannot message yourself. */}
          <div className="memorialActions">
            {!canManage ? (
              <ContactManager
                memorialId={detail.memorialId}
                label={t("contactManager")}
                signedIn={viewer.userId !== null}
                signInHref={`/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/memorials/${detail.slug}`)}`}
              />
            ) : null}
            {viewer.userId ? (
              <BookmarkButton
                memorialId={detail.memorialId}
                initialBookmarked={viewerBookmarked}
              />
            ) : null}
            {!canManage && viewer.userId ? (
              <FollowButton
                memorialId={detail.memorialId}
                initialFollowing={viewerFollowing}
              />
            ) : null}
            <Share
              url={memorialUrl({
                appUrl: env().APP_URL,
                locale,
                slug: detail.slug,
              })}
              title={detail.primaryName}
            />
          </div>
          {detail.publicNumber ? (
            <p className="memorialNumber">
              {t("memorialNumberLabel")}
              <span className="memorialNumberValue">{detail.publicNumber}</span>
            </p>
          ) : null}
            </header>
          }
        />

        <div className="memorialGrid">
          <div className="memorialMain">
            <section className="stack">
              <h2>{t("lifeStory")}</h2>
              {biography ? (
                <div className="stack">
                  {biography.title ? <h3>{biography.title}</h3> : null}
                  {/*
                   * Split into paragraphs rather than injected as markup. A
                   * family writes prose here, and nothing a visitor or an
                   * editor typed may become HTML on a page other people open.
                   */}
                  {biography.body
                    .split(/\n{2,}/)
                    .map((paragraph) => paragraph.trim())
                    .filter((paragraph) => paragraph.length > 0)
                    .map((paragraph, index) => (
                      <p key={`${biography.versionId}-${index}`}>
                        {paragraph}
                      </p>
                    ))}
                </div>
              ) : (
                <p className="muted">{t("noLifeStoryYet")}</p>
              )}
            </section>

            <LifeChapters locale={locale} chapters={chapters} />

            {disposition?.method ? (
              <DispositionCard
                heading={t("dispositionHeading")}
                method={t(`disp_${disposition.method}`)}
                place={disposition.place}
                placeLabel={t("dispositionPlaceLabel")}
                date={disposition.date}
                dateLabel={t("dispositionDateLabel")}
                note={disposition.note}
                lng={disposition.lng}
                lat={disposition.lat}
                photoUrl={disposition.photoUrl}
              />
            ) : null}

            <Contributions
              memorialId={detail.memorialId}
              locale={locale}
              initial={contributions}
              chapters={chapters.map((chapter) => ({
                id: chapter.id,
                chapterKey: chapter.chapterKey,
                customTitle: chapter.customTitle,
              }))}
              viewer={{
                verified: viewerStanding.verified,
                name: viewerStanding.name,
                relation: viewerStanding.relation,
              }}
            />

            {familyView ? (
              <FamilyTree
                tree={familyView.tree}
                locale={locale}
                heading={t("familyTreeHeading")}
                kinship={familyView.kinship}
                statusLiving={t("statusLiving")}
                statusDeceased={t("statusDeceased")}
                portraits={treePortraits}
                avatarsByName={treeAvatars}
                rootPortrait={rootPortrait}
              />
            ) : null}

            {familyView ? (
              <p>
                <Link
                  className="button buttonQuiet buttonCompact"
                  href={`/${locale}/memorials/${detail.slug}/family`}
                >
                  {t("fullTreeLink")} →
                </Link>
              </p>
            ) : null}

            <Guestbook
              memorialId={detail.memorialId}
              locale={locale}
              initial={stories}
              canModerate={canManage}
              isLoggedIn={viewer.userId !== null}
            />
          </div>
        </div>

        {/* Who manages the page, the owner's manage link, and — for a signed-in
         * visitor who does not manage it — the takeover request affordance. */}
        <div className="memorialManageFoot">
          {/* A platform-stewarded seed awaiting a claim has no family manager to
              name — showing the import steward as "本页管理员" only confuses. The
              steward banner already says the page is platform-built. */}
          {adminName && !awaitingClaim ? (
            <span className="muted memorialAdminLine">
              {t("currentAdminLabel")}
              {adminName}
            </span>
          ) : null}
          {canManage ? (
            <Link
              className="memorialManageLink"
              href={`/${locale}/memorials/${detail.slug}/manage`}
            >
              {t("manageLink")}
            </Link>
          ) : viewer.userId && !awaitingClaim ? (
            <TakeoverPanel
              memorialId={detail.memorialId}
              graceDays={TAKEOVER_GRACE_DAYS}
              mine={
                myTakeover
                  ? {
                      id: myTakeover.id,
                      kind: myTakeover.kind,
                      status: myTakeover.status,
                      canEscalate: myTakeover.canEscalate,
                    }
                  : null
              }
            />
          ) : null}
        </div>
      </article>
    </main>
  );
}
