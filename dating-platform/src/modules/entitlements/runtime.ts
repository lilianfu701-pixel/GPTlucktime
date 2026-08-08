import { db } from "@/infrastructure/db/client";

import { EntitlementService } from "./entitlement-service";
import type { EntitlementAuthorizer } from "./types";
import { UsageRepository } from "./usage-repository";

// Launch has no entitlement-specific verification threshold yet. Keeping this
// as an explicit adapter makes future email/phone/identity policy a server-only
// change instead of a caller-supplied boolean.
const launchVerificationResolver = async () => true;

const entitlementRepository = new UsageRepository(db, {
  verificationResolver: launchVerificationResolver,
});
export const entitlementService = new EntitlementService({
  store: entitlementRepository,
  timeResolver: (transaction) => entitlementRepository.authoritativeNow(transaction),
  policyResolver: (transaction, userId, key, now) =>
    entitlementRepository.resolvePolicyInTransaction(transaction, userId, key, now),
  planResolver: (transaction, userId, now) =>
    entitlementRepository.resolveActivePlanInTransaction(transaction, userId, now),
});
export const authorizeEntitlement: EntitlementAuthorizer = async (userId, key) =>
  (await entitlementService.decideForUser(userId, key)).allowed;
