import { createMyReportsHandler } from "@/modules/moderation/report-route";
import { myReportsRouteDependencies } from "@/modules/moderation/route-runtime";

export const GET = createMyReportsHandler(myReportsRouteDependencies);
