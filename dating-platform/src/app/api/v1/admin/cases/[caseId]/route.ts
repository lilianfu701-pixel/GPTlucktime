import { createAdminCaseDetailHandler } from "@/modules/admin/admin-route";
import { moderationAdminRouteDependencies } from "@/modules/admin/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createAdminCaseDetailHandler(moderationAdminRouteDependencies);
