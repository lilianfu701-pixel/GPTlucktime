import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { phoneNumber, twoFactor } from "better-auth/plugins";

import {
  NOTIFICATION_PROVIDER_UNAVAILABLE,
  NOTIFICATION_OUTBOX_UNAVAILABLE,
  type MessageDispatcher,
  type MessageSender,
} from "./message-sender";
import { AUTH_CREDENTIAL_TTL_SECONDS, credentialValidUntil } from "./auth-credentials";
import { SmsAbuseError, type SmsAbuseGuard, validateSmsTarget } from "./sms-abuse-guard";
import { resolveTrustedClientBucket } from "./trusted-ingress";
import { canonicalizeFreeTestEmail } from "./free-test-recipient";

export const PHONE_LOGIN_NOT_ENABLED = "PHONE_LOGIN_NOT_ENABLED";
const FREE_TEST_REDIRECT_MAX_BYTES = 4_096;

type AuthConfigurationInput = {
  database: BetterAuthOptions["database"];
  sender: MessageSender;
  dispatcher: MessageDispatcher;
  secret: string;
  baseURL: string;
  secureCookies: boolean;
  smsAbuseGuard?: SmsAbuseGuard;
  verifySmsChallenge?: (request: Request) => Promise<boolean>;
  trustedProxyToken?: string;
  freeTestMode?: boolean;
};

export function createAuthConfiguration(input: AuthConfigurationInput): BetterAuthOptions {
  return {
    database: input.database,
    secret: input.secret,
    baseURL: input.baseURL,
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: AUTH_CREDENTIAL_TTL_SECONDS.passwordReset,
      async sendResetPassword({ user, url }) {
        input.sender.assertAvailable("email");
        await input.dispatcher.enqueuePasswordReset({
          to: user.email,
          resetUrl: url,
          validUntil: credentialValidUntil("passwordReset"),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: AUTH_CREDENTIAL_TTL_SECONDS.emailVerification,
      async sendVerificationEmail({ user, url }) {
        input.sender.assertAvailable("email");
        await input.dispatcher.enqueueEmailVerification({
          to: user.email,
          verificationUrl: url,
          validUntil: credentialValidUntil("emailVerification"),
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (
          context.path === "/sign-in/phone-number" ||
          context.path === "/phone-number/request-password-reset" ||
          context.path === "/phone-number/reset-password"
        ) {
          throw new APIError("FORBIDDEN", {
            code: PHONE_LOGIN_NOT_ENABLED,
            message: PHONE_LOGIN_NOT_ENABLED,
          });
        }
        if (
          context.path === "/sign-up/email" ||
          context.path === "/send-verification-email" ||
          context.path === "/request-password-reset" ||
          (input.freeTestMode && context.path === "/sign-in/email")
        ) {
          const body = context.body as Record<string, unknown> | undefined;
          if (input.freeTestMode && (typeof body?.email !== "string"
            || !canonicalizeFreeTestEmail(body.email))) {
            throw new APIError("BAD_REQUEST", {
              code: "FREE_TEST_RECIPIENT_REQUIRED",
              message: "FREE_TEST_RECIPIENT_REQUIRED",
            });
          }
          const redirectField = context.path === "/request-password-reset" ? "redirectTo" : "callbackURL";
          const redirect = body?.[redirectField];
          if (input.freeTestMode && redirect !== undefined && (typeof redirect !== "string"
            || new TextEncoder().encode(redirect).byteLength > FREE_TEST_REDIRECT_MAX_BYTES)) {
            throw new APIError("BAD_REQUEST", {
              code: "FREE_TEST_REDIRECT_INVALID",
              message: "FREE_TEST_REDIRECT_INVALID",
            });
          }
          try {
            input.sender.assertAvailable("email");
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: NOTIFICATION_PROVIDER_UNAVAILABLE,
              message: NOTIFICATION_PROVIDER_UNAVAILABLE,
            });
          }
          try {
            await input.dispatcher.assertHealthy();
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: NOTIFICATION_OUTBOX_UNAVAILABLE,
              message: NOTIFICATION_OUTBOX_UNAVAILABLE,
            });
          }
          return;
        }
        if (context.path === "/phone-number/send-otp") {
          try {
            input.sender.assertAvailable("sms");
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: NOTIFICATION_PROVIDER_UNAVAILABLE,
              message: NOTIFICATION_PROVIDER_UNAVAILABLE,
            });
          }
          try {
            await input.dispatcher.assertHealthy();
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: NOTIFICATION_OUTBOX_UNAVAILABLE,
              message: NOTIFICATION_OUTBOX_UNAVAILABLE,
            });
          }
          const body = context.body as Record<string, unknown> | undefined;
          const target = typeof body?.phoneNumber === "string" ? body.phoneNumber : "";
          const request = context.request;
          const actorId = (context.context as unknown as { session?: { user?: { id?: string } } })
            .session?.user?.id;
          try {
            if (!input.smsAbuseGuard) throw new SmsAbuseError("SMS_ABUSE_GUARD_UNAVAILABLE", 503);
            await input.smsAbuseGuard.check({
              ip: request
                ? resolveTrustedClientBucket(request, input.trustedProxyToken)
                : "untrusted-network",
              actorId,
              target,
              challengeVerified: request && input.verifySmsChallenge
                ? await input.verifySmsChallenge(request)
                : false,
            });
          } catch (error) {
            const abuse = error instanceof SmsAbuseError
              ? error
              : new SmsAbuseError("SMS_ABUSE_GUARD_UNAVAILABLE", 503);
            const status = abuse.status === 400
              ? "BAD_REQUEST"
              : abuse.status === 403
                ? "FORBIDDEN"
                : abuse.status === 429
                  ? "TOO_MANY_REQUESTS"
                  : "SERVICE_UNAVAILABLE";
            throw new APIError(status, { code: abuse.code, message: abuse.code });
          }
        }
      }),
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: 60 * 60,
    },
    advanced: {
      useSecureCookies: input.secureCookies,
      database: { generateId: "uuid" },
      cookiePrefix: "dating_platform",
    },
    plugins: [
      twoFactor({ issuer: "Global Dating Platform" }),
      phoneNumber({
        requireVerification: true,
        expiresIn: AUTH_CREDENTIAL_TTL_SECONDS.phoneOtp,
        phoneNumberValidator: (value) => {
          if (!input.smsAbuseGuard) return false;
          try {
            validateSmsTarget(value, input.smsAbuseGuard.config);
            return true;
          } catch {
            return false;
          }
        },
        async sendOTP({ phoneNumber: to, code }) {
          input.sender.assertAvailable("sms");
          await input.dispatcher.enqueueSmsOtp({
            to,
            code,
            validUntil: credentialValidUntil("phoneOtp"),
          });
        },
      }),
    ],
  };
}
