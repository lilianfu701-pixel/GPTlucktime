// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

import * as schema from "@/db/schema";
import { createAuthConfiguration, PHONE_LOGIN_NOT_ENABLED } from "@/modules/auth/auth-config";
import {
  HttpMessageSender,
  InMemoryMessageSender,
  NOTIFICATION_PROVIDER_UNAVAILABLE,
  type MessageDispatcher,
  type MessageSender,
} from "@/modules/auth/message-sender";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createTestAuth(sender: MessageSender, dispatcher: MessageDispatcher) {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });
  const auth = betterAuth(createAuthConfiguration({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
      usePlural: true,
      transaction: true,
    }),
    sender,
    dispatcher,
    secret: "integration-test-secret-at-least-32-characters",
    baseURL: "http://localhost:3000",
    secureCookies: false,
  }));
  return { auth, client, database };
}

describe("Better Auth PostgreSQL integration", () => {
  it("fails signup before writing auth rows when email delivery is unavailable", async () => {
    const { auth, client, database } = await createTestAuth(
      new HttpMessageSender({}),
      { assertHealthy: async () => undefined, enqueueEmailVerification: async () => undefined, enqueuePasswordReset: async () => undefined, enqueueSmsOtp: async () => undefined },
    );

    try {
      const response = await auth.handler(new Request(
        "http://localhost:3000/api/auth/sign-up/email",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
          email: "unconfigured-sender@example.test",
          password: "strong-test-password",
          name: "No Sender",
          }),
        },
      ));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: NOTIFICATION_PROVIDER_UNAVAILABLE,
      });
      expect(await database.select().from(schema.users)).toHaveLength(0);
      expect(await database.select().from(schema.accounts)).toHaveLength(0);
      expect(await database.select().from(schema.sessions)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("does not commit signup when durable outbox enqueue fails", async () => {
    const { auth, client, database } = await createTestAuth(
      new InMemoryMessageSender(),
      {
        assertHealthy: async () => { throw new Error("OUTBOX_UNAVAILABLE"); },
        enqueueEmailVerification: async () => { throw new Error("OUTBOX_UNAVAILABLE"); },
        enqueuePasswordReset: async () => { throw new Error("OUTBOX_UNAVAILABLE"); },
        enqueueSmsOtp: async () => { throw new Error("OUTBOX_UNAVAILABLE"); },
      },
    );
    try {
      const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "outbox-failure@example.test",
          password: "strong-test-password",
          name: "Outbox Failure",
        }),
      }));
      expect(response.status).toBe(503);
      expect(await database.select().from(schema.users)).toHaveLength(0);
      expect(await database.select().from(schema.accounts)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("returns the same provider-unavailable response for every verification email", async () => {
    const { auth, client, database } = await createTestAuth(
      new HttpMessageSender({}),
      { assertHealthy: async () => undefined, enqueueEmailVerification: async () => undefined, enqueuePasswordReset: async () => undefined, enqueueSmsOtp: async () => undefined },
    );
    await database.insert(schema.users).values([
      { email: "unverified-existing@example.test", name: "Unverified" },
      { email: "verified-existing@example.test", name: "Verified", emailVerified: true },
    ]);

    try {
      const responses = await Promise.all([
        "unknown@example.test",
        "unverified-existing@example.test",
        "verified-existing@example.test",
      ].map((email) => auth.handler(new Request(
        "http://localhost:3000/api/auth/send-verification-email",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        },
      ))));
      expect(responses.map(({ status }) => status)).toEqual([503, 503, 503]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(bodies).toEqual(Array(3).fill({
        code: NOTIFICATION_PROVIDER_UNAVAILABLE,
        message: NOTIFICATION_PROVIDER_UNAVAILABLE,
      }));
    } finally {
      await client.close();
    }
  });

  it("returns the same provider-unavailable response for every password reset email", async () => {
    const { auth, client, database } = await createTestAuth(
      new HttpMessageSender({}),
      { assertHealthy: async () => undefined, enqueueEmailVerification: async () => undefined, enqueuePasswordReset: async () => undefined, enqueueSmsOtp: async () => undefined },
    );
    await database.insert(schema.users).values({
      email: "reset-existing@example.test",
      name: "Reset Existing",
      emailVerified: true,
    });
    try {
      const responses = await Promise.all([
        "reset-unknown@example.test",
        "reset-existing@example.test",
      ].map((email) => auth.handler(new Request(
        "http://localhost:3000/api/auth/request-password-reset",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, redirectTo: "http://localhost:3000/reset" }),
        },
      ))));
      expect(responses.map(({ status }) => status)).toEqual([503, 503]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(bodies).toEqual(Array(2).fill({
        code: NOTIFICATION_PROVIDER_UNAVAILABLE,
        message: NOTIFICATION_PROVIDER_UNAVAILABLE,
      }));
    } finally {
      await client.close();
    }
  });

  it.each([
    ["/sign-in/phone-number", (phoneNumber: string) => ({ phoneNumber, password: "arbitrary-password" })],
    ["/phone-number/request-password-reset", (phoneNumber: string) => ({ phoneNumber })],
  ])("rejects disabled phone credential path %s before account lookup or SMS", async (path, body) => {
    const sender = new InMemoryMessageSender();
    const { auth, client, database } = await createTestAuth(sender, {
      assertHealthy: async () => undefined,
      enqueueEmailVerification: async () => undefined,
      enqueuePasswordReset: async () => undefined,
      enqueueSmsOtp: async (message) => sender.sendSmsOtp(message, { deliveryKey: "test-phone-disabled" }),
    });
    await database.insert(schema.users).values([
      { email: "phone-verified@example.test", name: "Verified", phoneNumber: "+14155550101", phoneNumberVerified: true },
      { email: "phone-unverified@example.test", name: "Unverified", phoneNumber: "+14155550102", phoneNumberVerified: false },
    ]);
    try {
      const responses = await Promise.all([
        "+14155550101",
        "+14155550102",
        "+14155550103",
      ].map((phoneNumber) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(phoneNumber)),
      }))));
      expect(responses.map(({ status }) => status)).toEqual([403, 403, 403]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(bodies).toEqual(Array(3).fill({
        code: PHONE_LOGIN_NOT_ENABLED,
        message: PHONE_LOGIN_NOT_ENABLED,
      }));
      expect(sender.sms).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("registers a credential account and session in plural tables with UUID ids", async () => {
    const sender = new InMemoryMessageSender();
    const jobs: Array<() => Promise<void>> = [];
    const { auth, client, database } = await createTestAuth(sender, {
      assertHealthy: async () => undefined,
      enqueueEmailVerification: async (message) => {
        jobs.push(() => sender.sendEmailVerification(message, { deliveryKey: "test-email" }));
      },
      enqueuePasswordReset: async (message) => {
        jobs.push(() => sender.sendPasswordReset(message, { deliveryKey: "test-reset" }));
      },
      enqueueSmsOtp: async (message) => {
        jobs.push(() => sender.sendSmsOtp(message, { deliveryKey: "test-sms" }));
      },
    });
    const email = "pglite-user@example.test";
    const password = "strong-test-password";

    try {
      const signup = await auth.api.signUpEmail({
        body: { email, password, name: "PGlite User" },
      });
      expect(signup.token).toBeNull();
      expect(await database.select().from(schema.sessions)).toHaveLength(0);
      if (jobs.length !== 1) throw new Error("VERIFICATION_JOB_NOT_CAPTURED");
      await jobs.shift()!();
      const verificationMessage = sender.emails[0];
      if (!verificationMessage) throw new Error("VERIFICATION_MESSAGE_NOT_CAPTURED");
      const verificationToken = new URL(verificationMessage.verificationUrl).searchParams.get("token");
      if (!verificationToken) throw new Error("VERIFICATION_TOKEN_NOT_CAPTURED");

      await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toBeDefined();
      expect(await database.select().from(schema.sessions)).toHaveLength(0);
      await auth.api.verifyEmail({ query: { token: verificationToken } });
      await auth.api.signInEmail({ body: { email, password } });

      const [user] = await database.select().from(schema.users);
      const [account] = await database.select().from(schema.accounts);
      const [session] = await database.select().from(schema.sessions);
      expect(user.emailVerified).toBe(true);
      expect(user.id).toMatch(UUID);
      expect(account).toMatchObject({ providerId: "credential", userId: user.id });
      expect(account.id).toMatch(UUID);
      expect(session.userId).toBe(user.id);
      expect(session.id).toMatch(UUID);

      await expect(database.insert(schema.users).values({
        email,
        name: "Duplicate",
      })).rejects.toBeDefined();
      expect(await database.select().from(schema.users)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
