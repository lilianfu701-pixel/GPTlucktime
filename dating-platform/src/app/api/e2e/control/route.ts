import { authorizeE2eRequest } from "@/modules/e2e/e2e-guard";
import { listE2eDeliveries } from "@/modules/e2e/notification-adapter";
import { resetE2eState, seedPendingPhoto } from "@/modules/e2e/seed";

const denied = () => new Response(null, { status: 404 });

export async function GET(request: Request) {
  if (!authorizeE2eRequest(request).authorized) return denied();
  const url = new URL(request.url);
  const recipient = url.searchParams.get("recipient");
  const channel = url.searchParams.get("channel");
  const deliveries = listE2eDeliveries().filter((delivery) =>
    (!recipient || delivery.to === recipient) && (!channel || delivery.channel === channel));
  return Response.json({ deliveries }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorizeE2eRequest(request).authorized) return denied();
  let body: { action?: string; email?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
  if (body.action === "reset") return Response.json(await resetE2eState());
  if (body.action === "seed-photo" && typeof body.email === "string") {
    return Response.json(await seedPendingPhoto(body.email));
  }
  return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
}
