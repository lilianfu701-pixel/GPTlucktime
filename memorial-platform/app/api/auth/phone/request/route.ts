import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
} from "@/lib/api";
import { requestPhoneCode } from "@/modules/auth/service";

const schema = z.object({
  phone: z.string().min(1, { error: "A phone number is required." }),
  /** ISO 3166-1 alpha-2. Chosen by the caller; never inferred from the digits. */
  region: z.string().length(2, { error: "Select a country or region." }),
  locale: z.string().min(2).max(10).default("en"),
});

/**
 * Starts a phone sign-in.
 *
 * The route exists and is tested from the first release, but phase one keeps the
 * interface hidden and the feature switch off, so it answers FEATURE_DISABLED.
 * The switch is checked in the service, before any code is generated or sent.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await requestPhoneCode({
    phone: body.value.phone,
    region: body.value.region,
    locale: body.value.locale,
    requestIpHash: requestIpHash(request),
  });

  if (!result.ok) {
    if (result.error === "FEATURE_DISABLED") {
      return jsonError("FEATURE_DISABLED", correlationId);
    }
    return jsonUnprocessable(correlationId, {
      phone: ["Enter a phone number in international format, such as +14155550100."],
    });
  }

  return jsonSuccess({ challengeId: result.value.challengeId }, correlationId, 202);
}
