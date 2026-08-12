import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { createProductionDiscoveryRepository } from "@/modules/discovery/runtime";
import { createDiscoverHandler } from "@/modules/discovery/discovery-service";
import { authorizeEntitlement } from "@/modules/entitlements/runtime";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const repository = createProductionDiscoveryRepository(db, {
  cursorSecret: env.BETTER_AUTH_SECRET,
  disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
});

export const GET = createDiscoverHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  authorizeEntitlement,
  repository,
});
