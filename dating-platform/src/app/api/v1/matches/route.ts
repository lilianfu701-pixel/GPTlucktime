import { socialRouteDependencies } from "@/modules/social/route-runtime";
import { createSocialListHandler } from "@/modules/social/social-service";

export const GET = createSocialListHandler({ kind: "matches", ...socialRouteDependencies });
