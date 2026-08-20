import { createExportHandler } from "@/modules/profiles/privacy-route";
import { exportRouteDependencies } from "@/modules/profiles/privacy-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createExportHandler(exportRouteDependencies);
export const POST = handler;
export const GET = handler;
export const DELETE = handler;
export const PATCH = handler;
export const PUT = handler;
