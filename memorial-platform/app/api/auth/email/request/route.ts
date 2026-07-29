import { z } from "zod";
import {
  correlationIdFrom,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
} from "@/lib/api";
import { requestEmailCode } from "@/modules/auth/service";

const schema = z.object({
  email: z.string().min(1, { error: "An email address is required." }),
  locale: z.string().min(2).max(10).default("en"),
});

/**
 * Starts an email sign-in.
 *
 * Always answers 202 once the address is well formed, whether or not an account
 * exists. Distinguishing the two would let anyone test which addresses are
 * registered on a memorial platform. See 04-api-contracts.md section 3.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await requestEmailCode({
    email: body.value.email,
    locale: body.value.locale,
    requestIpHash: requestIpHash(request),
  });

  if (!result.ok) {
    return jsonUnprocessable(correlationId, {
      email: ["Enter a valid email address."],
    });
  }

  return jsonSuccess({ challengeId: result.value.challengeId }, correlationId, 202);
}
