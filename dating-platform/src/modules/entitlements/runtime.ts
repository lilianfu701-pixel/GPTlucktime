import { db } from "@/infrastructure/db/client";

import { EntitlementService } from "./entitlement-service";
import type { EntitlementAuthorizer } from "./types";
import { UsageRepository } from "./usage-repository";

export const entitlementRepository = new UsageRepository(db);
export const entitlementService = new EntitlementService({
  store: entitlementRepository,
  policyResolver: (userId) => entitlementRepository.resolvePolicy(userId),
});
export const authorizeEntitlement: EntitlementAuthorizer = async (userId, key) =>
  (await entitlementService.decideForUser(userId, key)).allowed;
