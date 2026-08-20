import { createAdminApprovalCollectionHandler } from "@/modules/admin/admin-route";
import { adminRouteDependencies } from "@/modules/admin/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createAdminApprovalCollectionHandler(adminRouteDependencies);
export const POST = createAdminApprovalCollectionHandler(adminRouteDependencies);
