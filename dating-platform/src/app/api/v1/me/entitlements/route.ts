import { createEntitlementsHandler } from "@/modules/entitlements/entitlement-service";
import { entitlementRouteDependencies } from "@/modules/entitlements/route-runtime";

export const GET = createEntitlementsHandler(entitlementRouteDependencies);
