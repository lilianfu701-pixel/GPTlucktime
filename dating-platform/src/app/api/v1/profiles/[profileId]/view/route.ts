import { socialRouteDependencies } from "@/modules/social/route-runtime";
import { createProfileActionHandler } from "@/modules/social/social-service";

export const POST = createProfileActionHandler({ action: "view", ...socialRouteDependencies });
