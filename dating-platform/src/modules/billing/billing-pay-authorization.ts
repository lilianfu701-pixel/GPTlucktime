import type { VerificationContextRepository, VerificationDecision,
  VerificationPolicyProvider } from "@/modules/auth/verification-policy";

export function createPayAuthorizer(deps: {
  contextRepository: VerificationContextRepository;
  policy: VerificationPolicyProvider;
}) {
  return async (userId: string) => {
    const context = await deps.contextRepository.get(userId);
    const required = await deps.policy.decide({ selfDeclaredCountryCode: context.selfDeclaredCountryCode,
      risk: context.risk, action: "pay" });
    const authorized = (Object.keys(required) as Array<keyof VerificationDecision>)
      .every((kind) => !required[kind] || context.satisfied[kind]);
    if (!authorized || !/^[A-Z]{2}$/u.test(context.selfDeclaredCountryCode)) return null;
    return { countryCode: context.selfDeclaredCountryCode };
  };
}
