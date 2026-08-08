import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { authorizeEntitlement } from "@/modules/entitlements/runtime";
import { readEnv } from "@/shared/env";

import { SocialRepository } from "./social-repository";

const env = readEnv(process.env);

export const socialRouteDependencies = {
  getSession: (headers: Headers) => auth.api.getSession({ headers }),
  authorizeEntitlement,
  repository: new SocialRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    idempotencySecret: env.BETTER_AUTH_SECRET,
  }),
};
