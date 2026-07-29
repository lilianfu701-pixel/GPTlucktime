import { z } from "zod";
import {
  correlationIdFrom,
  jsonError,
  jsonSuccess,
  jsonUnprocessable,
  readJson,
} from "@/lib/api";
import { currentActor } from "@/modules/auth/current-user";
import { inviteMember } from "@/modules/memorials/invitations";

const schema = z.object({
  email: z.string().min(1, { error: "An email address is required." }),
  // `owner` is absent: ownership moves by explicit transfer, not by link.
  role: z.enum(["admin", "editor", "reviewer", "invited_visitor"], {
    error: "Choose what this person may do.",
  }),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request);
  const { id } = await context.params;

  if (!z.uuid().safeParse(id).success) {
    return jsonError("MEMORIAL_NOT_FOUND", correlationId);
  }

  const actor = await currentActor();
  if (!actor.userId) {
    return jsonError("AUTH_REQUIRED", correlationId);
  }

  const body = await readJson(request, schema, correlationId);
  if (!body.ok) {
    return body.response;
  }

  const result = await inviteMember(actor, id, body.value, correlationId);

  if (!result.ok) {
    switch (result.error) {
      case "AUTH_REQUIRED":
        return jsonError("AUTH_REQUIRED", correlationId);
      case "MEMORIAL_NOT_FOUND":
        return jsonError("MEMORIAL_NOT_FOUND", correlationId);
      case "MEMORIAL_FORBIDDEN":
        return jsonError("MEMORIAL_FORBIDDEN", correlationId);
      case "ROLE_NOT_INVITABLE":
        return jsonUnprocessable(correlationId, {
          role: ["Ownership is transferred, not invited."],
        });
      case "INVALID_EMAIL":
        return jsonUnprocessable(correlationId, {
          email: ["Enter a valid email address."],
        });
      case "ALREADY_A_MEMBER":
        return jsonUnprocessable(correlationId, {
          email: ["This person already helps manage the memorial."],
        });
    }
  }

  // The token goes out by email from the worker. It is deliberately absent from
  // this response: whoever can invite need not also hold the credential.
  return jsonSuccess(
    {
      invitationId: result.value.invitationId,
      expiresAt: result.value.expiresAt.toISOString(),
    },
    correlationId,
    201,
  );
}
