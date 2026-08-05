import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { phoneNumber, twoFactor } from "better-auth/plugins";

import {
  NOTIFICATION_PROVIDER_UNAVAILABLE,
  type MessageDispatcher,
  type MessageSender,
} from "./message-sender";
import { SmsAbuseError, type SmsAbuseGuard, validateSmsTarget } from "./sms-abuse-guard";

type AuthConfigurationInput = {
  database: BetterAuthOptions["database"];
  sender: MessageSender;
  dispatcher: MessageDispatcher;
  secret: string;
  baseURL: string;
  secureCookies: boolean;
  smsAbuseGuard?: SmsAbuseGuard;
  verifySmsChallenge?: (request: Request) => Promise<boolean>;
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
      async sendResetPassword({ user, url }) {
        input.sender.assertAvailable("email");
        await input.dispatcher.enqueuePasswordReset({ to: user.email, resetUrl: url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        input.sender.assertAvailable("email");
        await input.dispatcher.enqueueEmailVerification({
          to: user.email,
          verificationUrl: url,
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (
          context.path === "/sign-up/email" ||
          context.path === "/send-verification-email" ||
          context.path === "/request-password-reset"
        ) {
          try {
            input.sender.assertAvailable("email");
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: NOTIFICATION_PROVIDER_UNAVAILABLE,
              message: NOTIFICATION_PROVIDER_UNAVAILABLE,
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
          const body = context.body as Record<string, unknown> | undefined;
          const target = typeof body?.phoneNumber === "string" ? body.phoneNumber : "";
          const request = context.request;
          const forwarded = request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
          const actorId = (context.context as unknown as { session?: { user?: { id?: string } } })
            .session?.user?.id;
          try {
            if (!input.smsAbuseGuard) throw new SmsAbuseError("SMS_ABUSE_GUARD_UNAVAILABLE", 503);
            await input.smsAbuseGuard.check({
              ip: forwarded || request?.headers.get("x-real-ip") || "unknown",
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
          await input.dispatcher.enqueueSmsOtp({ to, code });
        },
      }),
    ],
  };
}
