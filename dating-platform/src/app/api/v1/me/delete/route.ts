import { createDeletionHandler } from "@/modules/profiles/privacy-route";
import { deletionRouteDependencies } from "@/modules/profiles/privacy-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createDeletionHandler(deletionRouteDependencies);
export const POST = handler;
export const DELETE = handler;
export const GET = handler;
export const PATCH = handler;
export const PUT = handler;
