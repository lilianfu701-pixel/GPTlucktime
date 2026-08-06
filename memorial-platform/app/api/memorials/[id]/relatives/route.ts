import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { memorialRelatives } from "@/db/schema";
import { correlationIdFrom, jsonError, jsonSuccess, jsonUnprocessable, readJson } from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { memorialRoleFor } from "@/modules/memorials/membership";
import { canOnMemorial } from "@/modules/permissions/policy";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const role = await memorialRoleFor(id, actor.userId);
  if (!role) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  if (!canOnMemorial({ actor, role, action: "publish_content" })) {
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  const rows = await db()
    .select({
      id: memorialRelatives.id,
      name: memorialRelatives.name,
      relationshipToDeceased: memorialRelatives.relationshipToDeceased,
      isDeceased: memorialRelatives.isDeceased,
      showFullName: memorialRelatives.showFullName,
      displayOrder: memorialRelatives.displayOrder,
    })
    .from(memorialRelatives)
    .where(eq(memorialRelatives.memorialId, id))
    .orderBy(asc(memorialRelatives.displayOrder));

  return jsonSuccess({ relatives: rows }, correlationId);
}

const relativeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  relationshipToDeceased: z.string().trim().min(1).max(100),
  isDeceased: z.boolean(),
  showFullName: z.boolean().optional(),
});

const putSchema = z.object({
  relatives: z.array(relativeSchema).max(50),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const role = await memorialRoleFor(id, actor.userId);
  if (!role) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  if (!canOnMemorial({ actor, role, action: "publish_content" })) {
    return jsonError("MEMORIAL_FORBIDDEN", correlationId);
  }

  const parsed = await readJson(request, putSchema, correlationId);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { relatives } = parsed.value;

  const maxOne = new Set([
    "father",
    "mother",
    "husband",
    "wife",
  ]);

  const counts = new Map<string, number>();
  for (const r of relatives) {
    const c = (counts.get(r.relationshipToDeceased) ?? 0) + 1;
    counts.set(r.relationshipToDeceased, c);
    if (maxOne.has(r.relationshipToDeceased) && c > 1) {
      return jsonUnprocessable(correlationId, {
        relatives: [`Duplicate unique relationship: ${r.relationshipToDeceased}`],
      });
    }
  }

  await db().transaction(async (tx) => {
    await tx
      .delete(memorialRelatives)
      .where(eq(memorialRelatives.memorialId, id));

    for (let i = 0; i < relatives.length; i++) {
      const rel = relatives[i]!;
      await tx.insert(memorialRelatives).values({
        memorialId: id,
        name: rel.name,
        relationshipToDeceased: rel.relationshipToDeceased,
        isDeceased: rel.isDeceased,
        showFullName: rel.showFullName ?? rel.isDeceased,
        displayOrder: i,
      });
    }
  });

  return jsonSuccess({ saved: relatives.length }, correlationId);
}
