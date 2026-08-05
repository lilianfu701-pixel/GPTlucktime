import type { BetterAuthOptions } from "better-auth";
import { phoneNumber, twoFactor } from "better-auth/plugins";

import type { MessageDispatcher, MessageSender } from "./message-sender";

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
        input.sender.assertAvailable?.("email");
        input.dispatcher.dispatch(() => input.sender.sendEmailVerification({
          to: user.email,
          verificationUrl: url,
        }));
      },
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
          input.sender.assertAvailable?.("sms");
          input.dispatcher.dispatch(() => input.sender.sendSmsOtp({ to, code }));
        },
      }),
    ],
  };
}
