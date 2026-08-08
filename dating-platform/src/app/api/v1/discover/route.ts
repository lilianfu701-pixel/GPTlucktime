import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import { createDiscoverHandler } from "@/modules/discovery/discovery-service";
import { authorizeEntitlement } from "@/modules/entitlements/runtime";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const repository = new DiscoveryRepository(db, {
  cursorSecret: env.BETTER_AUTH_SECRET,
  disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
});

export const GET = createDiscoverHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  authorizeEntitlement,
  repository,
});
