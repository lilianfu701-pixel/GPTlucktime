import { createMessageReceiptsHandler } from "@/modules/messaging/message-service";
import { messagingRouteDependencies } from "@/modules/messaging/route-runtime";

export const GET = createMessageReceiptsHandler(messagingRouteDependencies);
