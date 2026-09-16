import { z } from "zod";
import { correlationIdFrom, jsonError, jsonSuccess, readJson } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { importGenealogy } from "@/modules/genealogy/import/importer";
import { ensureImportStewardActor } from "@/modules/genealogy/import/steward";
import { kongLineageSource } from "@/modules/genealogy/import/sources/kong-lineage";
import { songSuFamilySource } from "@/modules/genealogy/import/sources/song-su-family";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCES = {
  kong: kongLineageSource,
  song: songSuFamilySource,
};

const schema = z.object({
  source: z.enum(["kong", "song"]),
  /** Seed only deceased generations — the safe default for a first run. */
  skipLiving: z.boolean().optional(),
});

/**
 * Seeds a 族谱 batch into the platform from the admin panel — so a seed runs in
 * the production runtime (which already has the database) rather than anyone
 * pointing a script at the production database by hand.
 *
 * Super-admins only; returns 404 otherwise, so the endpoint's existence is not
 * disclosed. Idempotent: re-running creates nothing new. The seed runs as a
 * dedicated steward account, not the calling admin.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const actor = await currentActor();
  if (actor.platformRole !== "super_admin") {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const steward = await ensureImportStewardActor();
  const dataset = await SOURCES[body.value.source].load();
  const report = await importGenealogy(steward, dataset, {
    correlationId,
    ...(body.value.skipLiving !== undefined
      ? { skipLiving: body.value.skipLiving }
      : {}),
  });

  return jsonSuccess(report, correlationId, 200);
}
