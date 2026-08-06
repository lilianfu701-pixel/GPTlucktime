import { db } from "@/infrastructure/db/client";
import { auth } from "@/modules/auth/auth";
import { ProfileRepository } from "@/modules/profiles/profile-repository";
import { createProfileHandler } from "@/modules/profiles/profile-service";

const handler = createProfileHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  repository: new ProfileRepository(db),
});

export const GET = handler;
export const PATCH = handler;
