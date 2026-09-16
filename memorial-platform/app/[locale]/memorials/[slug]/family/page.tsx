import { asc, eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/db/client";
import { memorialRelatives } from "@/db/schema";
import { currentActor } from "@/modules/auth/current-user";
import { loadMemorialDetail } from "@/modules/memorials/detail";
import { familyViewForMemorial } from "@/modules/genealogy/family-view";
import { MAX_DEPTH, readTreeForMemorial } from "@/modules/genealogy/tree";
import { kinshipFromMemorial } from "@/modules/genealogy/kinship";
import { FamilyTree } from "../family-tree";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The full family chart on its own full-width page — every generation the
 * memorial records, grandparents included, with room the memorial column can't
 * give. Linked from the memorial's "family" section.
 */
export default async function FamilyTreePage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await props.params;
  setRequestLocale(locale);

  const t = await getTranslations("memorial");
  const actor = await currentActor();
  const result = await loadMemorialDetail(slug, actor);
  if (!result.ok) notFound();
  const { detail } = result;

  const relatives = await db()
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
    .orderBy(asc(memorialRelatives.displayOrder));

  const year = (
    date: string | null,
    precision: (typeof detail)["birthDatePrecision"],
  ): number | null =>
    date && precision !== "unknown" ? Number.parseInt(date.slice(0, 4), 10) : null;

  // Two ways a memorial's family can be recorded: free-text relatives on the
  // page (`memorial_relatives`, what a family types) and the confirmed family
  // graph (`family_links`, what an imported 族谱 uses). The full-tree page shows
  // whichever is richer — a family's own relatives view, or the deep graph walk
  // (up to five generations, with the collateral branches, spouses and children
  // the relatives view only reaches one step of). Graph nodes carry their own
  // kinship, derived over the whole graph.
  const [relativeView, graphResult] = await Promise.all([
    familyViewForMemorial(
      detail.memorialId,
      {
        name: detail.primaryName,
        birthYear: year(detail.birthDate, detail.birthDatePrecision),
        deathYear: year(detail.deathDate, detail.deathDatePrecision),
      },
      relatives,
      {
        recurse: false,
        viewerLoggedIn: actor.userId !== null,
        hiddenLabel: t("nameHiddenPlaceholder"),
      },
    ),
    readTreeForMemorial(actor, detail.memorialId, { depth: MAX_DEPTH }),
  ]);

  const graphTree = graphResult.ok ? graphResult.value : null;
  const visible = (tree: { nodes: { visible: boolean }[] } | null): number =>
    tree ? tree.nodes.filter((node) => node.visible).length : 0;

  const familyView =
    graphTree && visible(graphTree) > visible(relativeView?.tree ?? null)
      ? { tree: graphTree, kinship: await kinshipFromMemorial(detail.memorialId) }
      : relativeView;

  return (
    <main id="main" className="section familyPage">
      <div className="container">
        <header className="stack measure">
          <p className="eyebrow">{detail.primaryName}</p>
          <h1>{t("fullTreeTitle")}</h1>
          <p>
            <Link
              className="button buttonQuiet buttonCompact"
              href={`/${locale}/memorials/${detail.slug}`}
            >
              ← {t("enterMemorial")}
            </Link>
          </p>
        </header>
      </div>

      {familyView ? (
        <FamilyTree
          tree={familyView.tree}
          locale={locale}
          heading=""
          kinship={familyView.kinship}
          statusLiving={t("statusLiving")}
          statusDeceased={t("statusDeceased")}
        />
      ) : (
        <div className="container">
          <p className="muted">{t("fullTreeEmpty")}</p>
        </div>
      )}
    </main>
  );
}
