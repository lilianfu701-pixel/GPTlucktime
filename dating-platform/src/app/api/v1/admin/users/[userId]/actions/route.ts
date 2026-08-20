import { createAdminUserActionsHandler } from "@/modules/admin/admin-route";
import { adminRouteDependencies } from "@/modules/admin/runtime";

export const POST = createAdminUserActionsHandler(adminRouteDependencies);
