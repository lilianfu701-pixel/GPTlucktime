import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import { createSavedSearchHandler } from "@/modules/discovery/discovery-service";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const handler = createSavedSearchHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  repository: new DiscoveryRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
  }),
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
