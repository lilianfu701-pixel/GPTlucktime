import { socialRouteDependencies } from "@/modules/social/route-runtime";
import { createProfileActionHandler } from "@/modules/social/social-service";

const handler = createProfileActionHandler({ action: "favorite", ...socialRouteDependencies });

export const POST = handler;
export const DELETE = handler;
