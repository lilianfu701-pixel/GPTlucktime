/**
 * Runs a genealogy import against the local `memorial_dev` database, then proves
 * the chain: pages created, edges confirmed, and — the point of it — kinship the
 * source never stated derived by the engine from the graph alone.
 *
 *   npx tsx scripts/genealogy-import.ts --dry-run              # plan only, no writes
 *   npx tsx scripts/genealogy-import.ts                        # 三苏 (default)
 *   npx tsx scripts/genealogy-import.ts --source=kong          # 孔子世系 first batch
 *   npx tsx scripts/genealogy-import.ts --source=kong --skip-living  # deceased only
 *
 * The import runs as one staff steward who ends up owning every seed page, so
 * the parent and spouse edges confirm on creation and the graph is traversable
 * at once. Idempotent: re-running creates nothing new. Local dev only.
 */
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { loadEnvFileIfPresent } from "@/lib/load-env-file";
import {
  deceasedPeople,
  emailCredentials,
  familyPeople,
  memorialNames,
  memorials,
  users,
} from "@/db/schema";
import type { Actor } from "@/modules/permissions/types";
import { importGenealogy } from "@/modules/genealogy/import/importer";
import type { GenealogySource } from "@/modules/genealogy/import/types";
import { songSuFamilySource } from "@/modules/genealogy/import/sources/song-su-family";
import { kongLineageSource } from "@/modules/genealogy/import/sources/kong-lineage";
import { soongFamilySource } from "@/modules/genealogy/import/sources/wikidata-soong";
import { kinshipFromMemorial } from "@/modules/genealogy/kinship";
import { kinshipLabel } from "@/modules/genealogy/kinship-terms";

loadEnvFileIfPresent();

const STEWARD_EMAIL = "genealogy-import@missingu.org";

/** Sources by `--source=` name, each with the person to read kinship from. */
const SOURCES: Record<string, { source: GenealogySource; root: string }> = {
  song: { source: songSuFamilySource, root: "su-mai" },
  kong: { source: kongLineageSource, root: "kong-weiyi" },
  soong: { source: soongFamilySource, root: "Q17132" },
};

async function ensureStewardUser(): Promise<string> {
  const existing = await db()
    .select({ userId: emailCredentials.userId })
    .from(emailCredentials)
    .where(eq(emailCredentials.email, STEWARD_EMAIL))
    .limit(1);
  if (existing[0]) return existing[0].userId;

  const [user] = await db()
    .insert(users)
    .values({
      displayName: "族谱导入管理员",
      fullName: "族谱导入管理员",
      preferredLocale: "zh-CN",
    })
    .returning({ id: users.id });

  await db().insert(emailCredentials).values({
    userId: user!.id,
    email: STEWARD_EMAIL,
    verifiedAt: new Date(),
  });

  return user!.id;
}

/** familyPeople id → the primary name on the memorial behind it. */
async function namesByFamilyPersonId(
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select({ personId: familyPeople.id, name: memorialNames.value })
    .from(familyPeople)
    .innerJoin(
      deceasedPeople,
      eq(deceasedPeople.id, familyPeople.deceasedPersonId),
    )
    .innerJoin(memorials, eq(memorials.deceasedPersonId, deceasedPeople.id))
    .leftJoin(
      memorialNames,
      and(
        eq(memorialNames.memorialId, memorials.id),
        eq(memorialNames.type, "primary"),
      ),
    )
    .where(inArray(familyPeople.id, ids));

  const map = new Map<string, string>();
  for (const row of rows) map.set(row.personId, row.name ?? "—");
  return map;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const skipLiving = process.argv.includes("--skip-living");
  const sourceArg =
    process.argv.find((a) => a.startsWith("--source="))?.split("=")[1] ?? "song";
  const chosen = SOURCES[sourceArg];
  if (!chosen) {
    process.stderr.write(
      `unknown --source=${sourceArg}; known: ${Object.keys(SOURCES).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const ROOT_EXTERNAL_ID = chosen.root;

  const userId = await ensureStewardUser();
  const actor: Actor = { userId, platformRole: "super_admin" };

  const dataset = await chosen.source.load();
  const report = await importGenealogy(actor, dataset, { dryRun, skipLiving });

  const lines: string[] = [
    `source:            ${report.source}`,
    `mode:              ${report.dryRun ? "DRY RUN (no writes)" : "import"}`,
    `people:            ${report.peopleTotal}`,
    `relations:         ${report.relationsTotal}`,
    `memorials created: ${report.memorialsCreated}`,
    `memorials existing:${report.memorialsExisting}`,
    `living (masked):   ${report.livingCreated} created, ${report.livingExisting} existing`,
    `links created:     ${report.linksCreated}`,
    `links existing:    ${report.linksExisting}`,
    `issues:            ${report.issues.length}`,
  ];
  for (const issue of report.issues) {
    lines.push(`  ! [${issue.stage}] ${issue.externalId ?? ""} ${issue.error}`);
  }
  for (const m of report.memorials) {
    lines.push(
      `  ${m.created ? "+" : "="} ${m.name}  /zh-CN/memorials/${m.slug}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");

  if (dryRun) {
    await closeDb();
    return;
  }

  // The proof: read one person's family and show what the engine derives from
  // the graph — relationships the fixture never stated.
  const root = report.memorials.find((m) => m.externalId === ROOT_EXTERNAL_ID);
  if (root) {
    const kin = await kinshipFromMemorial(root.memorialId);
    const names = await namesByFamilyPersonId([...kin.keys()]);
    const derived: string[] = [
      "",
      `derived kinship — 以「${root.name}」为本人（引擎从家谱图推断，非源数据）:`,
    ];
    for (const [personId, k] of kin) {
      const name = names.get(personId) ?? personId;
      const label = kinshipLabel(k, "zh-CN") ?? k.kind;
      derived.push(`  ${name} → ${label}`);
    }
    process.stdout.write(derived.join("\n") + "\n");
  }

  await closeDb();
}

main().catch((error: unknown) => {
  process.stderr.write(`genealogy-import failed: ${String(error)}\n`);
  process.exitCode = 1;
});
