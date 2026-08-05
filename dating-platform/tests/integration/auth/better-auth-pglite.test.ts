// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

import * as schema from "@/db/schema";
import { createAuthConfiguration } from "@/modules/auth/auth-config";
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
      { dispatch: () => undefined },
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

  it("registers a credential account and session in plural tables with UUID ids", async () => {
    const sender = new InMemoryMessageSender();
    const jobs: Array<() => Promise<void>> = [];
    const { auth, client, database } = await createTestAuth(sender, {
      dispatch: (job) => jobs.push(job),
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
