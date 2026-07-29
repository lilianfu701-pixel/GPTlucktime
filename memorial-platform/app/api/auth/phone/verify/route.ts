import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
  userAgentFrom,
} from "@/lib/api";
import { flags } from "@/lib/feature-flags";
import { setSessionCookie } from "@/modules/auth/cookies";
import { verifyCode } from "@/modules/auth/service";

const schema = z.object({
  challengeId: z.uuid({ error: "This sign-in request is no longer valid." }),
  code: z
    .string()
    .regex(/^\d{6}$/, { error: "Enter the six digit code you received." }),
  locale: z.string().min(2).max(10).default("en"),
});

/**
 * Completes a phone sign-in.
 *
 * The switch is re-checked here, not only at request time: turning phone
 * sign-in off must stop challenges that were already issued from completing.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  if (!flags().phoneAuthEnabled) {
    return jsonError("FEATURE_DISABLED", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await verifyCode({
    challengeId: body.value.challengeId,
    code: body.value.code,
    expectedChannel: "phone",
    locale: body.value.locale,
    requestIpHash: requestIpHash(request),
    userAgent: userAgentFrom(request),
  });

  if (!result.ok) {
    // One public answer for every failure reason, as with email verification.
    return jsonUnprocessable(correlationId, {
      code: ["That code did not work. Request a new one."],
    });
  }

  const response = jsonSuccess({ userId: result.value.userId }, correlationId, 200);
  return setSessionCookie(response, {
    token: result.value.token,
    expiresAt: result.value.expiresAt,
  });
}
