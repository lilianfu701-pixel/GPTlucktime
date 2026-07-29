import { z } from "zod";
import {
  correlationIdFrom,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
  userAgentFrom,
} from "@/lib/api";
import { setSessionCookie } from "@/modules/auth/cookies";
import { verifyCode } from "@/modules/auth/service";

const schema = z.object({
  challengeId: z.uuid({ error: "This sign-in request is no longer valid." }),
  code: z
    .string()
    .regex(/^\d{6}$/, { error: "Enter the six digit code from your email." }),
  locale: z.string().min(2).max(10).default("en"),
});

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await verifyCode({
    challengeId: body.value.challengeId,
    code: body.value.code,
    expectedChannel: "email",
    locale: body.value.locale,
    requestIpHash: requestIpHash(request),
    userAgent: userAgentFrom(request),
  });

  if (!result.ok) {
    // One answer for every reason. Whether the code was wrong, expired, already
    // used or now locked, the caller learns only that it did not work: naming
    // the reason would help an attacker tune their guessing. The precise reason
    // is in the attempt log, for the family and for support.
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
