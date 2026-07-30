import { z } from "zod";
import {
  correlationIdFrom,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
  requestIpHash,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { submitReport } from "@/modules/governance/reports";

const schema = z.object({
  resourceType: z.enum([
    "memorial",
    "commemoration",
    "visitor_submission",
    "media",
  ]),
  resourceId: z.uuid({ error: "That item is not available." }),
  category: z.enum([
    "identity_impersonation",
    "false_death",
    "privacy_violation",
    "harassment_or_hate",
    "violent_or_explicit",
    "spam",
    "copyright",
    "religious_or_cultural_error",
    "ownership_dispute",
    "other_safety",
  ]),
  description: z.string().max(4000).optional(),
  contactEmail: z.string().max(254).optional(),
});

/**
 * Receives a complaint.
 *
 * No sign-in required: a person who finds a memorial impersonating their
 * relative should not have to register an account before they can say so.
 *
 * The answer is the same whatever the report says, and reveals nothing about
 * the item reported. A reporter learns the outcome by email, if they left an
 * address, once a reviewer has looked at it.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const actor = await currentActor();

  const result = await submitReport(actor, body.value, {
    requestIpHash: requestIpHash(request),
  });

  if (!result.ok) {
    if (result.error === "INVALID_CONTACT") {
      return jsonUnprocessable(correlationId, {
        contactEmail: ["Enter a valid email address, or leave it blank."],
      });
    }
    return jsonUnprocessable(correlationId, {
      description: ["Please describe what is wrong."],
    });
  }

  // 202: received, not acted upon. Doc 06 section 6 puts a reviewer between a
  // complaint and any action, and the response should not suggest otherwise.
  return jsonSuccess({ reportId: result.value.reportId }, correlationId, 202);
}
