import { db } from "@/infrastructure/db/client";
import {
  createIdentityVerificationWebhookHandler,
  processIdentityVerificationWebhook,
} from "@/modules/auth/identity-verification-webhook";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const handleWebhook = createIdentityVerificationWebhookHandler({
  provider: env.IDENTITY_VERIFICATION_PROVIDER,
  secret: env.IDENTITY_VERIFICATION_WEBHOOK_SECRET,
  processEvent: (provider, event) => processIdentityVerificationWebhook(db, provider, event),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return handleWebhook(request, provider);
}
