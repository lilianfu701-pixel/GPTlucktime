import { getTranslations } from "next-intl/server";
import { discoverClaimableKin } from "@/modules/genealogy/self-discovery";
import { toSimplified, toTraditional } from "@/modules/search/hanzi";
import { KinClaimCard } from "./kin-claim-card";
import type { KinCandidateView } from "./kin-claim-card";

/** A Chinese name shown in the viewer's channel script (陈 for 简体, 陳 for 繁體). */
function inViewerScript(name: string, locale: string): string {
  if (locale === "zh-TW" || locale === "zh-HK") return toTraditional(name);
  if (locale === "zh-CN") return toSimplified(name);
  return name;
}

/**
 * Register → recognise yourself. Shows the signed-in person any masked 族谱 node
 * that matches their name across scripts, and lets them claim their place. Shown
 * on their own account page, beside the deceased-relative mentions. Renders
 * nothing when there is no name to match on or no candidate — most people, most
 * of the time.
 */
export async function KinClaimPrompt(props: {
  fullName: string | null;
  locale: string;
}) {
  const name = props.fullName?.trim();
  if (!name) return null;

  const candidates = await discoverClaimableKin({ fullName: name });
  if (candidates.length === 0) return null;

  const t = await getTranslations("profile");

  // The match is on the viewer's own name, so it is theirs to see in full —
  // only shown in their channel's script.
  const shownName = inViewerScript(name, props.locale);
  const views: KinCandidateView[] = candidates.map((c) => ({
    personId: c.personId,
    name: shownName,
    generationLabel: c.generationName
      ? t("kinPromptGeneration", {
          generation: inViewerScript(c.generationName, props.locale),
        })
      : null,
  }));

  return (
    <KinClaimCard
      candidates={views}
      strings={{
        lead: t("kinPromptLead"),
        claim: t("kinPromptClaim"),
        hint: t("kinPromptHint"),
        claimed: t("kinPromptClaimed"),
      }}
    />
  );
}
