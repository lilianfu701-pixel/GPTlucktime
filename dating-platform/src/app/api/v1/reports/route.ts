import { createReportsHandler } from "@/modules/moderation/report-route";
import { reportRouteDependencies } from "@/modules/moderation/route-runtime";

export const POST = createReportsHandler(reportRouteDependencies);
