// @vitest-environment node

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

import * as schema from "@/db/schema";
import { createAuthConfiguration } from "@/modules/auth/auth-config";
import { InMemoryMessageSender } from "@/modules/auth/message-sender";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Better Auth PostgreSQL integration", () => {
  it("registers a credential account and session in plural tables with UUID ids", async () => {
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
      sender: new InMemoryMessageSender(),
      dispatcher: { dispatch: () => undefined },
      secret: "integration-test-secret-at-least-32-characters",
      baseURL: "http://localhost:3000",
      secureCookies: false,
    }));
    const email = "pglite-user@example.test";
    const password = "strong-test-password";

    await auth.api.signUpEmail({ body: { email, password, name: "PGlite User" } });
    await database.update(schema.users).set({ emailVerified: true });
    await auth.api.signInEmail({ body: { email, password } });

    const [user] = await database.select().from(schema.users);
    const [account] = await database.select().from(schema.accounts);
    const [session] = await database.select().from(schema.sessions);
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
    await client.close();
  });
});
