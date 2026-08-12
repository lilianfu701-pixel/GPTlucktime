import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import { createSavedSearchHandler } from "@/modules/discovery/discovery-service";
import { authorizeEntitlement } from "@/modules/entitlements/runtime";
import { DrizzleModerationContentPolicy } from "@/modules/moderation/content-policy";
import { DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const handler = createSavedSearchHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  authorizeEntitlement,
  repository: new DiscoveryRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
    restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
    contentPolicy: new DrizzleModerationContentPolicy(),
  }),
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
