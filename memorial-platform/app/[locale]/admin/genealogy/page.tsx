import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { currentActor } from "@/modules/auth/current-user";
import {
  wikidataFamilyList,
  wikidataImportedCounts,
} from "@/modules/genealogy/import/sources/wikidata-families";
import { importedWikidataExternalIds } from "@/modules/genealogy/import/status";
import { GenealogySeed } from "./genealogy-seed";

export const dynamic = "force-dynamic";

/**
 * Seeds 族谱 batches from within the running app, so no one has to point a script
 * at the production database. Super-admins only; the surrounding layout already
 * turns non-staff away, and this turns away non-super-admins.
 */
export default async function AdminGenealogyPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const actor = await currentActor();
  if (actor.platformRole !== "super_admin") {
    notFound();
  }

  // Real per-family import state from the database, so the panel shows what is
  // already seeded on load instead of a blank 待导入.
  const imported = wikidataImportedCounts(await importedWikidataExternalIds());

  return (
    <div className="stack-lg">
      <h1>族谱导入</h1>
      <p className="muted measure">
        从公有领域的族谱世系批量建立可认领的追思页，并连成族谱图。导入的页面公开、可搜索、可被搜索引擎收录，但
        <strong>不进入首页「最新追思」</strong>。幂等：重复导入不会重复建立。在世者默认跳过。
      </p>
      <GenealogySeed
        locale={locale}
        families={wikidataFamilyList}
        imported={imported}
      />
    </div>
  );
}
