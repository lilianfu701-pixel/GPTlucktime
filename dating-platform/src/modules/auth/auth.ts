import "server-only";

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { after } from "next/server";

import * as schema from "@/db/schema";
import { db } from "@/infrastructure/db/client";
import { readEnv } from "@/shared/env";

import { createAuthConfiguration } from "./auth-config";
import { BackgroundMessageDispatcher, HttpMessageSender } from "./message-sender";

const env = readEnv(process.env);
const sender = new HttpMessageSender({
  email: env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_TOKEN
    ? { endpoint: env.EMAIL_WEBHOOK_URL, token: env.EMAIL_WEBHOOK_TOKEN }
    : undefined,
  sms: env.SMS_WEBHOOK_URL && env.SMS_WEBHOOK_TOKEN
    ? { endpoint: env.SMS_WEBHOOK_URL, token: env.SMS_WEBHOOK_TOKEN }
    : undefined,
});
const dispatcher = new BackgroundMessageDispatcher((operation) => after(operation));

export const auth = betterAuth(createAuthConfiguration({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
    transaction: true,
  }),
  sender,
  dispatcher,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL,
  secureCookies: env.NODE_ENV === "production",
}));
