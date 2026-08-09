import { z } from "zod";

const forbiddenControls = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
const loneSurrogate = /[\uD800-\uDFFF]/u;
const messageInput = z.object({
  clientId: z.string().uuid(),
  body: z.string(),
}).strict();

export function normalizeSendMessageInput(value: unknown) {
  const parsed = messageInput.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_MESSAGE");
  const body = parsed.data.body.normalize("NFC");
  if (body.trim().length === 0 || Array.from(body).length > 2000
    || forbiddenControls.test(body) || loneSurrogate.test(body)) throw new Error("INVALID_MESSAGE");
  return { clientId: parsed.data.clientId, body };
}
