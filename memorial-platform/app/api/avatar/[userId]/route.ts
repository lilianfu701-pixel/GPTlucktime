import { currentActor } from "@/modules/auth/current-user";
import { avatarBytesForUser } from "@/modules/identity/avatar";

export const dynamic = "force-dynamic";

/**
 * A stable, same-origin address for an account's avatar.
 *
 * The object store address is signed (and short-lived) or on a host some
 * regions cannot reach, so — like a memorial 遗像 at `/api/portrait/[slug]` —
 * the bytes are streamed through this origin instead. An avatar is released
 * only to the account holder, or, once they opt to appear on a family chart, to
 * anyone; the guard lives in `avatarBytesForUser`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const { userId } = await context.params;

  if (!userId || userId.length > 64) {
    return new Response(null, { status: 404 });
  }

  const actor = await currentActor();

  let image: { bytes: Uint8Array; contentType: string } | null = null;
  try {
    image = await avatarBytesForUser(userId, actor.userId ?? null);
  } catch {
    image = null;
  }

  if (!image) {
    return new Response(null, { status: 404 });
  }

  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      "content-type": image.contentType,
      // Per-viewer only: the same path returns a private avatar to its owner and
      // 404 to everyone else, so it must never land in a shared cache.
      "cache-control": "private, max-age=300",
    },
  });
}
