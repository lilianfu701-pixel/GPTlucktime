import { createRealtimeTicketHandler } from "@/modules/messaging/message-service";
import { messagingRouteDependencies } from "@/modules/messaging/route-runtime";

export const POST = createRealtimeTicketHandler(messagingRouteDependencies);
