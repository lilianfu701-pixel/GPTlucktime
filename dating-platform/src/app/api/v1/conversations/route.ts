import { createConversationsHandler } from "@/modules/messaging/message-service";
import { messagingRouteDependencies } from "@/modules/messaging/route-runtime";

const handler = createConversationsHandler(messagingRouteDependencies);

export const GET = handler;
export const POST = handler;
