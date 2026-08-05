import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { phoneNumber, twoFactor } from "better-auth/plugins";

import {
  NOTIFICATION_PROVIDER_UNAVAILABLE,
  type MessageDispatcher,
  type MessageSender,
} from "./message-sender";

type AuthConfigurationInput = {
  database: BetterAuthOptions["database"];
  sender: MessageSender;
  dispatcher: MessageDispatcher;
  secret: string;
  baseURL: string;
  secureCookies: boolean;
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
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        input.sender.assertAvailable("email");
        input.dispatcher.dispatch(() => input.sender.sendEmailVerification({
          to: user.email,
          verificationUrl: url,
        }));
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-up/email") return;
        try {
          input.sender.assertAvailable("email");
        } catch {
          throw new APIError("SERVICE_UNAVAILABLE", {
            code: NOTIFICATION_PROVIDER_UNAVAILABLE,
            message: NOTIFICATION_PROVIDER_UNAVAILABLE,
          });
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
        sendOTP({ phoneNumber: to, code }) {
          input.sender.assertAvailable("sms");
          input.dispatcher.dispatch(() => input.sender.sendSmsOtp({ to, code }));
        },
      }),
    ],
  };
}
