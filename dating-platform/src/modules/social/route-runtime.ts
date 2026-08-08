import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { readEnv } from "@/shared/env";

import { SocialRepository } from "./social-repository";

const env = readEnv(process.env);

export const socialRouteDependencies = {
  getSession: (headers: Headers) => auth.api.getSession({ headers }),
  repository: new SocialRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    idempotencySecret: env.BETTER_AUTH_SECRET,
  }),
};
