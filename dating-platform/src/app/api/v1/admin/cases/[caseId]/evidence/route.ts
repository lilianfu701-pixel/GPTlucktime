import { createAdminEvidenceReadHandler } from "@/modules/admin/admin-route";
import { adminRouteDependencies } from "@/modules/admin/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createAdminEvidenceReadHandler(adminRouteDependencies);
