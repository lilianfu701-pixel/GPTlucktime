export const AUTH_CREDENTIAL_TTL_SECONDS = {
  phoneOtp: 300,
  emailVerification: 3_600,
  passwordReset: 3_600,
} as const;

export const credentialValidUntil = (
  kind: keyof typeof AUTH_CREDENTIAL_TTL_SECONDS,
  now = new Date(),
) => new Date(now.getTime() + AUTH_CREDENTIAL_TTL_SECONDS[kind] * 1_000);
