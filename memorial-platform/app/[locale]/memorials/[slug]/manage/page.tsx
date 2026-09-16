import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/db/client";
import {
  memorialMembers,
  memorialNames,
  memorialRelatives,
  memorials,
} from "@/db/schema";
import { memorialFamilyLinks } from "@/modules/genealogy/memorial-graph";
import { normalizeLocale } from "@/lib/locale";
import { currentActor } from "@/modules/auth/current-user";
import {
  latestBiographyDraft,
  publishedBiography,
} from "@/modules/memorials/content-service";
import { loadMemorialDetail } from "@/modules/memorials/detail";
import { manageableMedia } from "@/modules/media/service";
import { canOnMemorial } from "@/modules/permissions/policy";
import { listPendingClaims } from "@/modules/memorials/recognition";
import { ritualChoices } from "@/modules/religion/memorial-settings";
import { ManageForms } from "./manage-forms";
import { PhotoManager } from "./photo-manager";
import { DetailsEditor } from "./details-editor";
import { FamilyEditor } from "./family-editor";
import { PrivacyEditor } from "./privacy-editor";
import { RelativesEditor } from "./relatives-editor";
import { RecognitionReview } from "./recognition-review";
import { OfferingsToggle } from "./offerings-toggle";
import { getOfferingsDisabled } from "@/modules/offerings/settings";
import { ChaptersEditor } from "./chapters-editor";
import { ChannelsEditor } from "./channels-editor";
import { PublishAll } from "./publish-all";
import { listManageChapters } from "@/modules/memorials/life-chapters";
import { DispositionEditor } from "./disposition-editor";
import { getDisposition } from "@/modules/memorials/disposition";
import { listBlocked } from "@/modules/memorials/blocking";
import { BlockedList } from "./blocked-list";
import { getObituary } from "@/modules/memorials/obituary";
import { listPendingTakeovers } from "@/modules/memorials/ownership";
import { TransferOwnership } from "./transfer-ownership";
import { TakeoverRequests } from "./takeover-requests";
import { ContributionsReview } from "./contributions-review";
import { listPendingContributions } from "@/modules/memorials/contributions";

export const dynamic = "force-dynamic";

/** Never indexed: this is a family's workspace, not a page about anyone. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function ManageMemorialPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const actor = await currentActor();
  const result = await loadMemorialDetail(slug, actor);

  if (!result.ok) {
    notFound();
  }

  const { detail } = result;

  /*
   * A viewer who may read the memorial but not edit it gets a 404 rather than
   * a refusal. They already know the page exists — the memorial itself told
   * them — but nothing here should confirm that a management surface is where
   * they guessed it might be.
   */
  const role = detail.viewerRole === "public_visitor" ? null : detail.viewerRole;
  const mayEditStory = canOnMemorial({ actor, role, action: "publish_content" });
  const mayConfigure = canOnMemorial({ actor, role, action: "configure_rituals" });
  const offeringsDisabled = mayConfigure
    ? await getOfferingsDisabled(detail.memorialId)
    : [];
  const mayManageFamily = canOnMemorial({
    actor,
    role,
    action: "manage_family_links",
  });
  const mayModerate = canOnMemorial({
    actor,
    role,
    action: "moderate_submission",
  });

  if (!mayEditStory && !mayConfigure) {
    notFound();
  }

  const normalized = normalizeLocale(locale);

  const [
    published,
    draft,
    rituals,
    photos,
    existingRelatives,
    familyLinks,
    otherMemorials,
  ] = await Promise.all([
    publishedBiography(detail.memorialId),
    latestBiographyDraft(detail.memorialId),
    mayConfigure ? ritualChoices(detail.memorialId, normalized) : [],
    mayEditStory ? manageableMedia(detail.memorialId) : [],
    mayEditStory
      ? db()
          .select({
            id: memorialRelatives.id,
            name: memorialRelatives.name,
            relationshipToDeceased: memorialRelatives.relationshipToDeceased,
            isDeceased: memorialRelatives.isDeceased,
            showFullName: memorialRelatives.showFullName,
            nameVisibility: memorialRelatives.nameVisibility,
            coParentId: memorialRelatives.coParentId,
            spouseOfId: memorialRelatives.spouseOfId,
          })
          .from(memorialRelatives)
          .where(eq(memorialRelatives.memorialId, detail.memorialId))
          .orderBy(asc(memorialRelatives.displayOrder))
      : [],
    mayConfigure ? memorialFamilyLinks(detail.memorialId) : [],
    // The owner's other memorials, offered as things to link this one to.
    mayConfigure && actor.userId
      ? db()
          .select({ id: memorials.id, name: memorialNames.value })
          .from(memorialMembers)
          .innerJoin(memorials, eq(memorials.id, memorialMembers.memorialId))
          .leftJoin(
            memorialNames,
            and(
              eq(memorialNames.memorialId, memorials.id),
              eq(memorialNames.type, "primary"),
            ),
          )
          .where(
            and(
              eq(memorialMembers.userId, actor.userId),
              isNull(memorialMembers.revokedAt),
              isNull(memorials.deletionRequestedAt),
              ne(memorials.id, detail.memorialId),
            ),
          )
          .orderBy(desc(memorials.createdAt))
      : [],
  ]);

  // The draft is what they were last writing; the published version is what
  // visitors see. Editing continues from the draft when one is ahead.
  const editing = draft ?? published;

  // People the family has blocked from the guestbook, so they can be lifted.
  const blocked = mayEditStory ? await listBlocked(detail.memorialId) : [];

  // The obituary (讣告) the family can write, publish and share.
  const obituary = mayEditStory ? await getObituary(detail.memorialId) : null;

  // Offerings income, payouts and the donation ledger now live in the owner's
  // account finances (账户 → 财务), not on each memorial's manage page.
  const isOwner = detail.viewerRole === "owner";
  // A super-admin approves claims the platform's own steward account can't — a
  // seeded page's owner is a bot no one signs in as, so its takeover requests
  // would otherwise never be answered.
  const isSuperAdmin = actor.platformRole === "super_admin";
  const takeovers =
    isOwner || isSuperAdmin
      ? await listPendingTakeovers(detail.memorialId)
      : [];

  // The structured life story, broken into chapters. Editing is the same
  // capability as editing the biography.
  const chapters = mayEditStory
    ? await listManageChapters(detail.memorialId)
    : null;

  // The final resting arrangement (身后安置) — the last chapter of the life.
  const disposition = mayEditStory
    ? await getDisposition(detail.memorialId)
    : null;

  // Which channels list this memorial, and whether it is featured on their
  // homepages — the owner's control over homepage display.
  const [channelsRow] = mayConfigure
    ? await db()
        .select({
          regions: memorials.regions,
          homepageDisplay: memorials.homepageDisplay,
        })
        .from(memorials)
        .where(eq(memorials.id, detail.memorialId))
    : [];

  // Friend-and-family remembrances awaiting review.
  const pendingContributions = mayModerate
    ? await listPendingContributions(detail.memorialId)
    : null;


  // People asking to be recognised as a relative of this person. Only someone
  // trusted with the family links sees or answers them.
  const roleLabel = (relationship: string): string => {
    const key = `relativeRole_${relationship}`;
    return t.has(key) ? t(key) : relationship;
  };
  const pendingClaims = mayManageFamily
    ? await listPendingClaims(actor, detail.memorialId)
    : null;
  const recognitionClaims =
    pendingClaims && pendingClaims.ok
      ? pendingClaims.value.claims.map((claim) => ({
          id: claim.id,
          claimedName: claim.claimedName,
          relationLabel: roleLabel(claim.claimedRelationship),
          kinshipVerified: claim.kinshipVerified,
        }))
      : [];

  const hasReview =
    (mayManageFamily && recognitionClaims.length > 0) ||
    Boolean(pendingContributions && pendingContributions.length > 0);

  // What the single "save and publish" button at the foot of the page will make
  // live: a biography draft that is ahead of the published version, and every
  // chapter whose saved draft has not yet been published.
  const biographyDraftPending =
    draft !== null && draft.version !== (published?.version ?? -1);
  const publishableChapterIds = (chapters ?? [])
    .filter((c) => c.latestVersion > 0 && (!c.hasPublished || c.hasUnpublishedEdit))
    .map((c) => c.id);

  return (
    <main id="main" className="container section">
      <div className="manageLayout stack-lg">
        <header>
          <h1 className="manageName">{detail.primaryName}</h1>
        </header>

        {mayEditStory ? (
          <div className="manageCard">
            <PhotoManager memorialId={detail.memorialId} initial={photos} />
          </div>
        ) : null}

        {mayEditStory ? (
          <div className="manageCard">
            <DetailsEditor
              memorialId={detail.memorialId}
              initialBirth={
                detail.birthDatePrecision === "day" && detail.birthDate
                  ? detail.birthDate.slice(0, 10)
                  : ""
              }
              initialDeath={
                detail.deathDatePrecision === "day" && detail.deathDate
                  ? detail.deathDate.slice(0, 10)
                  : ""
              }
            />
          </div>
        ) : null}

        {hasReview ? (
          <section className="manageGroup">
            <p className="manageGroupLabel isAction">
              {t("manageGroupAction")}
            </p>
            {mayManageFamily && recognitionClaims.length > 0 ? (
              <div className="manageCard">
                <RecognitionReview
                  memorialId={detail.memorialId}
                  initial={recognitionClaims}
                />
              </div>
            ) : null}
            {pendingContributions && pendingContributions.length > 0 ? (
              <div className="manageCard">
                <ContributionsReview
                  memorialId={detail.memorialId}
                  locale={normalized}
                  initial={pendingContributions}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {mayEditStory || mayConfigure ? (
          <section className="manageGroup">
            <p className="manageGroupLabel">{t("manageGroupContent")}</p>
            <div className="manageCard">
              <ManageForms
                memorialId={detail.memorialId}
                locale={normalized}
                slug={detail.slug}
                mayEditStory={mayEditStory}
                mayConfigure={mayConfigure}
                initialTitle={editing?.title ?? ""}
                initialBody={editing?.body ?? ""}
                hasUnpublishedDraft={biographyDraftPending}
                rituals={rituals
                  .filter((choice) => choice.name !== null)
                  .map((choice) => ({
                    ritualVersionId: choice.ritualVersionId,
                    name: choice.name as string,
                    description: choice.description,
                    enabled: choice.enabled,
                    allowAnonymous: choice.allowAnonymous,
                    allowMessage: choice.allowMessage,
                    moderationMode: choice.moderationMode,
                  }))}
              />
            </div>
            {chapters ? (
              <div className="manageCard">
                <ChaptersEditor
                  memorialId={detail.memorialId}
                  locale={normalized}
                  initial={chapters}
                />
              </div>
            ) : null}
            {disposition ? (
              <div className="manageCard">
                <DispositionEditor
                  memorialId={detail.memorialId}
                  initial={disposition}
                />
              </div>
            ) : null}
            {mayEditStory ? (
              <div className="manageCard stack">
                <h2>{t("obituaryHeading")}</h2>
                <p className="muted" style={{ margin: 0 }}>
                  {obituary?.published
                    ? t("obituaryStatusPublished")
                    : t("obituaryStatusDraft")}
                </p>
                <div>
                  <Link
                    className="button buttonQuiet buttonCompact"
                    href={`/${normalized}/obituary/new?memorial=${detail.slug}`}
                  >
                    {t("obituaryManageLink")}
                  </Link>
                </div>
              </div>
            ) : null}
            {mayEditStory ? (
              <div className="manageCard">
                <BlockedList
                  memorialId={detail.memorialId}
                  initial={blocked.map((b) => ({
                    userId: b.userId,
                    name: b.name,
                  }))}
                />
              </div>
            ) : null}
            {isOwner || isSuperAdmin ? (
              <div className="manageCard">
                <TakeoverRequests
                  memorialId={detail.memorialId}
                  initial={takeovers.map((r) => ({
                    id: r.id,
                    kind: r.kind,
                    requesterName: r.requesterName,
                    relationship: r.relationship,
                    reason: r.reason,
                  }))}
                />
              </div>
            ) : null}
            {isOwner ? (
              <div className="manageCard">
                <TransferOwnership memorialId={detail.memorialId} />
              </div>
            ) : null}
          </section>
        ) : null}

        {mayEditStory || mayConfigure ? (
          <section className="manageGroup">
            <p className="manageGroupLabel">{t("manageGroupFamily")}</p>
            {mayEditStory ? (
              <div className="manageCard">
                <RelativesEditor
                  memorialId={detail.memorialId}
                  initial={existingRelatives}
                />
              </div>
            ) : null}
            {mayConfigure ? (
              <div className="manageCard">
                <FamilyEditor
                  memorialId={detail.memorialId}
                  locale={locale}
                  initial={familyLinks}
                  others={otherMemorials.map((other) => ({
                    id: other.id,
                    name: other.name ?? "—",
                  }))}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {mayConfigure ? (
          <section className="manageGroup">
            <p className="manageGroupLabel">{t("manageGroupSettings")}</p>
            <div className="manageCard">
              <PrivacyEditor
                memorialId={detail.memorialId}
                initialVisibility={detail.visibility}
                initialIndexable={detail.searchEngineIndexable}
              />
            </div>
            {channelsRow ? (
              <div className="manageCard">
                <ChannelsEditor
                  memorialId={detail.memorialId}
                  initialRegions={channelsRow.regions}
                  initialHomepageDisplay={channelsRow.homepageDisplay}
                />
              </div>
            ) : null}
            <div className="manageCard">
              <OfferingsToggle
                memorialId={detail.memorialId}
                disabled={offeringsDisabled}
              />
            </div>
          </section>
        ) : null}

        {mayEditStory ? (
          <PublishAll
            memorialId={detail.memorialId}
            locale={normalized}
            slug={detail.slug}
            publishBiography={biographyDraftPending}
            chapterIds={publishableChapterIds}
          />
        ) : null}

        <p className="manageFooterLink">
          <Link
            className="button buttonQuiet buttonCompact"
            href={`/${locale}/memorials/${detail.slug}`}
          >
            {t("enterMemorial")} →
          </Link>
        </p>
      </div>
    </main>
  );
}
