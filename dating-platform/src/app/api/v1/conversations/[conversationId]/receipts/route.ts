import { createMessageReceiptsHandler } from "@/modules/messaging/message-service";
import { messagingRouteDependencies } from "@/modules/messaging/route-runtime";

const handler = createMessageReceiptsHandler(messagingRouteDependencies);

export const GET = handler;
export const POST = handler;
