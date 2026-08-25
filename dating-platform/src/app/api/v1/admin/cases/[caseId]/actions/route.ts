import { createAdminCaseActionHandler } from "@/modules/admin/admin-route";
import { moderationAdminRouteDependencies } from "@/modules/admin/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createAdminCaseActionHandler(moderationAdminRouteDependencies);
