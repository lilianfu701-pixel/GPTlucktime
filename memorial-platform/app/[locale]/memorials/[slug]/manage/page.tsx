import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { normalizeLocale } from "@/lib/locale";
import { currentActor } from "@/modules/auth/current-user";
import {
  latestBiographyDraft,
  publishedBiography,
} from "@/modules/memorials/content-service";
import { loadMemorialDetail } from "@/modules/memorials/detail";
import { canOnMemorial } from "@/modules/permissions/policy";
import { ritualChoices } from "@/modules/religion/memorial-settings";
import { ManageForms } from "./manage-forms";

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

  if (!mayEditStory && !mayConfigure) {
    notFound();
  }

  const normalized = normalizeLocale(locale);

  const [published, draft, rituals] = await Promise.all([
    publishedBiography(detail.memorialId),
    latestBiographyDraft(detail.memorialId),
    mayConfigure ? ritualChoices(detail.memorialId, normalized) : [],
  ]);

  // The draft is what they were last writing; the published version is what
  // visitors see. Editing continues from the draft when one is ahead.
  const editing = draft ?? published;

  return (
    <main id="main" className="container section stack-lg">
      <header className="stack measure">
        <p className="eyebrow">{detail.primaryName}</p>
        <h1>{t("manageTitle")}</h1>
      </header>

      <ManageForms
        memorialId={detail.memorialId}
        locale={normalized}
        slug={detail.slug}
        mayEditStory={mayEditStory}
        mayConfigure={mayConfigure}
        initialTitle={editing?.title ?? ""}
        initialBody={editing?.body ?? ""}
        hasUnpublishedDraft={
          draft !== null && draft.version !== (published?.version ?? -1)
        }
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
    </main>
  );
}
