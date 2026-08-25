import { replayE2eStripeFixture } from "@/modules/e2e/billing-fixture";
import { authorizeE2eRequest } from "@/modules/e2e/e2e-guard";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const denied = () => new Response(null, { status: 404 });
const authorizeQuery = (request: Request, url: URL) => authorizeE2eRequest(new Request(request.url, {
  headers: { "x-e2e-token": url.searchParams.get("token") ?? "" },
})).authorized;
const html = (body: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Stripe test adapter</title></head><body><main>${body}</main></body></html>`, {
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" },
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId") ?? "";
  if (!authorizeQuery(request, url) || !uuid.test(orderId)) return denied();
  const action = url.pathname + url.search.replaceAll("&", "&amp;");
  return html(`<h1>Local Stripe test adapter</h1><p>This guarded localhost fixture does not connect to live Stripe.</p><form method="post" action="${action}"><button type="submit">Confirm local test checkout</button></form>`);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId") ?? "";
  if (!authorizeQuery(request, url) || !uuid.test(orderId)) return denied();
  await replayE2eStripeFixture(orderId, "activate");
  return html(`<h1>Local test checkout confirmed</h1><p>The signed local fixture was accepted.</p><a href="/en/settings/membership?e2eCheckout=confirmed">Return to membership</a>`);
}
