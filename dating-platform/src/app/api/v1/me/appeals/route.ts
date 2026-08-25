import { auth } from "@/modules/auth/auth";
import { createMemberAppealsHandler } from "@/modules/moderation/appeal-route";
import { moderationAcceptanceService } from "@/modules/admin/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createMemberAppealsHandler({
  getSession: async (headers) => {
    const session = await auth.api.getSession({ headers });
    return session ? { user: { id: session.user.id } } : null;
  },
  service: moderationAcceptanceService,
});
export const GET = handler;
export const POST = handler;
