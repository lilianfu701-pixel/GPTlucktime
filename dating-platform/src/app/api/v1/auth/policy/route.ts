import { auth } from "@/modules/auth/auth";
import { verificationContextRepository } from "@/modules/auth/verification-context-repository";
import { createVerificationPolicyHandler } from "@/modules/auth/verification-policy";

export const POST = createVerificationPolicyHandler({
  getSession: (headers) => auth.api.getSession({ headers }),
  contextRepository: verificationContextRepository,
});
