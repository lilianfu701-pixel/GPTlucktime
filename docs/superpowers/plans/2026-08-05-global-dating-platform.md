# Global Dating Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready responsive global dating website with configurable verification, discovery, matching, real-time chat, moderation, paid memberships, and an operations console.

**Architecture:** Create a new `dating-platform/` Next.js App Router application organized as a modular monolith. PostgreSQL is the source of truth, Redis provides caching/limits, an outbox-backed worker handles asynchronous work, and a separate Socket.IO process provides real-time delivery while sharing contracts and persistence with the web application.

**Tech Stack:** Next.js App Router, TypeScript, React, PostgreSQL, Drizzle ORM/Kit, Better Auth, Redis, BullMQ, Socket.IO, S3-compatible object storage, Stripe Billing, Zod, Vitest, Testing Library, Playwright, OpenTelemetry.

---

## Program split and delivery order

The approved specification covers several subsystems. Execute this plan in five testable increments:

1. **Foundation:** Tasks 1-4 produce a runnable bilingual application with authentication, policy-controlled verification, profiles, and media upload.
2. **Dating loop:** Tasks 5-7 add discovery, likes, matches, and the configurable entitlement engine.
3. **Communication and safety:** Tasks 8-10 add persistent chat, real-time delivery, blocking, reporting, and moderation.
4. **Commerce and operations:** Tasks 11-12 add subscriptions, Stripe reconciliation, and the RBAC operations console.
5. **Launch readiness:** Tasks 13-15 add privacy workflows, observability, security gates, end-to-end tests, and deployment documentation.

Do not start an increment until the previous increment's full test command passes.

## File structure

```text
dating-platform/
├── src/
│   ├── app/
│   │   ├── [locale]/(marketing)/page.tsx
│   │   ├── [locale]/(auth)/sign-in/page.tsx
│   │   ├── [locale]/(member)/discover/page.tsx
│   │   ├── [locale]/(member)/messages/page.tsx
│   │   ├── [locale]/(member)/settings/page.tsx
│   │   ├── [locale]/admin/page.tsx
│   │   └── api/v1/
│   ├── modules/
│   │   ├── auth/              # Better Auth configuration and verification policy
│   │   ├── profiles/          # Profile, preferences, photos, visibility
│   │   ├── discovery/         # Candidate filtering, ranking, saved searches
│   │   ├── social/            # Likes, favorites, matches, blocks
│   │   ├── entitlements/      # Server-side feature decisions and usage limits
│   │   ├── messaging/         # Conversations, messages, receipts, socket tickets
│   │   ├── moderation/        # Reports, cases, actions, appeals, risk signals
│   │   ├── billing/           # Plans, prices, subscriptions, Stripe webhooks
│   │   ├── admin/             # RBAC and audited operations
│   │   └── notifications/     # In-app, email, SMS, push routing
│   ├── db/schema/             # One schema file per business domain
│   ├── infrastructure/        # Database, Redis, queue, storage, tracing adapters
│   ├── shared/                # IDs, errors, pagination, time, validation
│   └── workers/               # Outbox, media, notification, moderation jobs
├── realtime/                  # Independently runnable Socket.IO delivery process
├── drizzle/                   # Generated, reviewed SQL migrations
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
├── docker-compose.yml
├── drizzle.config.ts
├── playwright.config.ts
├── vitest.config.ts
└── package.json
```

Each module owns its schema, service, repository, policy, route handlers, and tests. Cross-module calls go through exported service interfaces; route handlers never query another module's tables directly.

## Authoritative references

- [Next.js App Router](https://nextjs.org/docs/app)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Better Auth installation and Drizzle adapter](https://better-auth.com/docs/installation)
- [Better Auth phone verification](https://better-auth.com/docs/plugins/phone-number)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)

### Task 1: Scaffold the application and local dependencies

**Files:**
- Create: `dating-platform/package.json`
- Create: `dating-platform/docker-compose.yml`
- Create: `dating-platform/src/app/[locale]/layout.tsx`
- Create: `dating-platform/src/app/[locale]/(marketing)/page.tsx`
- Create: `dating-platform/src/shared/env.ts`
- Create: `dating-platform/vitest.config.ts`
- Create: `dating-platform/tests/unit/env.test.ts`

- [ ] **Step 1: Scaffold Next.js and install runtime/test dependencies**

Run:

```bash
npx create-next-app@latest dating-platform --typescript --eslint --app --src-dir --import-alias "@/*" --use-npm
cd dating-platform
npm install drizzle-orm pg zod better-auth redis bullmq socket.io socket.io-client stripe @aws-sdk/client-s3 @aws-sdk/s3-request-presigner next-intl
npm install -D drizzle-kit @types/pg vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom @playwright/test
```

Expected: `dating-platform/package.json` exists and `npm install` exits 0.

- [ ] **Step 2: Write the failing environment test**

```ts
// dating-platform/tests/unit/env.test.ts
import { describe, expect, it } from "vitest";
import { readEnv } from "@/shared/env";

describe("readEnv", () => {
  it("rejects an incomplete server environment", () => {
    expect(() => readEnv({ NODE_ENV: "test" })).toThrow("DATABASE_URL");
  });
});
```

- [ ] **Step 3: Run the test and verify the expected failure**

Run: `npm run test -- tests/unit/env.test.ts`

Expected: FAIL because `@/shared/env` does not exist.

- [ ] **Step 4: Add validated environment loading and local services**

```ts
// dating-platform/src/shared/env.ts
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  APP_URL: z.string().url(),
});

export type AppEnv = z.infer<typeof schema>;
export const readEnv = (input: NodeJS.ProcessEnv): AppEnv => schema.parse(input);
```

Add scripts to `package.json`: `test: vitest run`, `test:watch: vitest`, `test:e2e: playwright test`, `db:generate: drizzle-kit generate`, `db:migrate: drizzle-kit migrate`, `check: npm run lint && npm run test && npm run build`.

Create `docker-compose.yml` with named services `postgres` on 5432, `redis` on 6379, and `minio` on 9000/9001; use named volumes rather than host paths.

- [ ] **Step 5: Verify and commit**

Run: `npm run test -- tests/unit/env.test.ts && npm run lint`

Expected: PASS and zero lint errors.

```bash
git add dating-platform
git commit -m "chore: scaffold dating platform"
```

### Task 2: Establish database conventions and the identity/profile schema

**Files:**
- Create: `dating-platform/drizzle.config.ts`
- Create: `dating-platform/src/infrastructure/db/client.ts`
- Create: `dating-platform/src/db/schema/auth.ts`
- Create: `dating-platform/src/db/schema/profiles.ts`
- Create: `dating-platform/src/db/schema/index.ts`
- Create: `dating-platform/tests/unit/schema/profile-schema.test.ts`

- [ ] **Step 1: Write the failing schema contract test**

```ts
// dating-platform/tests/unit/schema/profile-schema.test.ts
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { profiles } from "@/db/schema";

describe("profiles schema", () => {
  it("stores inclusive identity and discovery state", () => {
    const columns = getTableColumns(profiles);
    expect(Object.keys(columns)).toEqual(expect.arrayContaining([
      "userId", "displayName", "birthDate", "genderCode", "countryCode",
      "city", "bio", "discoverable", "status",
    ]));
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- tests/unit/schema/profile-schema.test.ts`

Expected: FAIL because `@/db/schema` is missing.

- [ ] **Step 3: Implement focused schema files**

Define Better Auth-owned `users`, `sessions`, `accounts`, and `verifications` in `auth.ts`. Define `profiles`, `profile_preferences`, `profile_photos`, `interests`, `profile_interests`, `privacy_settings`, and `verification_attempts` in `profiles.ts`.

Use UUID primary keys, `timestamptz`, ISO 3166-1 alpha-2 country codes, date-only birth dates, and text codes for gender/relationship values. Add unique constraints for one profile and one privacy settings row per user; add indexes on discoverable/status/country/birth date and photo moderation status.

```ts
// dating-platform/src/infrastructure/db/client.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { readEnv } from "@/shared/env";

const env = readEnv(process.env);
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
export const db = drizzle({ client: pool, schema });
```

- [ ] **Step 4: Generate and inspect the first migration**

Run: `npm run db:generate -- --name init_identity_profiles`

Expected: a new SQL migration under `dating-platform/drizzle/` with foreign keys and indexes; no destructive statement.

- [ ] **Step 5: Verify and commit**

Run: `npm run test -- tests/unit/schema/profile-schema.test.ts && npx drizzle-kit check`

Expected: PASS and migration consistency check succeeds.

```bash
git add dating-platform/src/db dating-platform/src/infrastructure/db dating-platform/drizzle dating-platform/drizzle.config.ts dating-platform/tests/unit/schema
git commit -m "feat: add identity and profile schema"
```

### Task 3: Configure authentication and policy-controlled verification

**Files:**
- Create: `dating-platform/src/modules/auth/auth.ts`
- Create: `dating-platform/src/modules/auth/client.ts`
- Create: `dating-platform/src/modules/auth/verification-policy.ts`
- Create: `dating-platform/src/modules/auth/identity-verification-adapter.ts`
- Create: `dating-platform/src/app/api/auth/[...all]/route.ts`
- Create: `dating-platform/src/app/api/v1/auth/policy/route.ts`
- Create: `dating-platform/src/app/api/v1/auth/identity-verification/route.ts`
- Create: `dating-platform/tests/unit/auth/verification-policy.test.ts`

- [ ] **Step 1: Write the failing verification policy test**

```ts
// dating-platform/tests/unit/auth/verification-policy.test.ts
import { describe, expect, it } from "vitest";
import { decideVerification } from "@/modules/auth/verification-policy";

describe("decideVerification", () => {
  it("requires phone and identity for high-risk messaging", () => {
    expect(decideVerification({ countryCode: "US", risk: "high", action: "message" }))
      .toEqual({ email: true, phone: true, liveness: true, identity: true });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- tests/unit/auth/verification-policy.test.ts`

Expected: FAIL because the policy module is missing.

- [ ] **Step 3: Implement Better Auth and policy evaluation**

Configure Better Auth with the Drizzle adapter, email/password, email verification, phone-number plugin, session rotation, secure cookies, and two-factor plugin. SMS sending must call a `SmsSender` interface; tests use an in-memory sender and production uses the configured provider.

```ts
// dating-platform/src/modules/auth/verification-policy.ts
export type VerificationDecision = {
  email: boolean; phone: boolean; liveness: boolean; identity: boolean;
};

export function decideVerification(input: {
  countryCode: string; risk: "low" | "medium" | "high"; action: "browse" | "message" | "pay";
}): VerificationDecision {
  const elevated = input.risk === "high";
  return {
    email: true,
    phone: input.action !== "browse" || elevated,
    liveness: elevated,
    identity: elevated || input.action === "pay",
  };
}
```

Mount the Better Auth handler at `/api/auth/[...all]`. The policy endpoint returns only unmet requirements, not risk scores or internal rule names.

Define an `IdentityVerificationAdapter` with `createSession`, `getResult`, and `cancelSession`. The route creates a vendor-hosted liveness/identity session only after policy evaluation and stores the vendor reference plus status; it never returns or stores raw document images. A signed vendor callback updates the attempt idempotently and expires older approvals according to policy.

- [ ] **Step 4: Add route contract tests and run auth tests**

Run: `npm run test -- tests/unit/auth`

Expected: PASS for default, messaging, payment, and high-risk policy cases.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/modules/auth dating-platform/src/app/api/auth dating-platform/src/app/api/v1/auth dating-platform/tests/unit/auth
git commit -m "feat: add configurable authentication policy"
```

### Task 4: Build onboarding, profiles, privacy, and media review

**Files:**
- Create: `dating-platform/src/modules/profiles/profile-schema.ts`
- Create: `dating-platform/src/modules/profiles/profile-service.ts`
- Create: `dating-platform/src/modules/profiles/profile-repository.ts`
- Create: `dating-platform/src/modules/profiles/media-service.ts`
- Create: `dating-platform/src/workers/media-review-worker.ts`
- Create: `dating-platform/src/app/api/v1/me/profile/route.ts`
- Create: `dating-platform/src/app/api/v1/me/photos/route.ts`
- Create: `dating-platform/src/app/[locale]/(member)/onboarding/page.tsx`
- Create: `dating-platform/tests/unit/profiles/profile-service.test.ts`

- [ ] **Step 1: Write the failing age and visibility tests**

```ts
// dating-platform/tests/unit/profiles/profile-service.test.ts
import { describe, expect, it } from "vitest";
import { assertAdult, publicProfile } from "@/modules/profiles/profile-service";

describe("profile rules", () => {
  it("rejects a user younger than 18", () => {
    expect(() => assertAdult("2010-08-05", new Date("2026-08-05T12:00:00Z"))).toThrow("AGE_RESTRICTED");
  });

  it("never returns precise coordinates", () => {
    const result = publicProfile({ id: "p1", city: "Seattle", latitude: 47.61, longitude: -122.33 });
    expect(result).toEqual({ id: "p1", city: "Seattle" });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/profiles/profile-service.test.ts`

Expected: FAIL because profile service is missing.

- [ ] **Step 3: Implement validation, repository, and signed uploads**

Use Zod to validate localized display name, date-only birth date, supported identity codes, ISO country code, city, biography length, interests, and preferences. Compute age from the user's configured legal date boundary, not milliseconds. `publicProfile` must whitelist fields.

`POST /me/photos` returns a short-lived signed object-storage upload request. The completion endpoint creates a `pending` photo record and enqueues `media.review.requested`; only `approved` photos are exposed.

`media-review-worker.ts` validates the object key belongs to the user, verifies file signature and dimensions, runs malware/content checks through adapters, writes an immutable review result, changes the photo to `approved` or `rejected`, and deletes rejected binaries after the evidence-retention period.

- [ ] **Step 4: Add integration coverage**

Run: `npm run test -- tests/unit/profiles tests/integration/profiles`

Expected: PASS for adult boundary, privacy filtering, profile completeness, upload ownership, and rejected photo visibility.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/modules/profiles dating-platform/src/app/api/v1/me dating-platform/src/app/[locale]/\(member\)/onboarding dating-platform/tests
git commit -m "feat: add onboarding and moderated profiles"
```

### Task 5: Implement discovery filters and explainable ranking

**Files:**
- Create: `dating-platform/src/modules/discovery/discovery-types.ts`
- Create: `dating-platform/src/modules/discovery/candidate-policy.ts`
- Create: `dating-platform/src/modules/discovery/ranking.ts`
- Create: `dating-platform/src/modules/discovery/discovery-repository.ts`
- Create: `dating-platform/src/app/api/v1/discover/route.ts`
- Create: `dating-platform/src/app/api/v1/saved-searches/route.ts`
- Create: `dating-platform/src/app/[locale]/(member)/discover/page.tsx`
- Create: `dating-platform/tests/unit/discovery/ranking.test.ts`

- [ ] **Step 1: Write failing hard-filter and ranking tests**

```ts
// dating-platform/tests/unit/discovery/ranking.test.ts
import { describe, expect, it } from "vitest";
import { rankCandidate } from "@/modules/discovery/ranking";

describe("rankCandidate", () => {
  it("cannot buy a path around a safety exclusion", () => {
    const score = rankCandidate({ eligible: false, preference: 1, interests: 1, activity: 1, boost: 9 });
    expect(score).toBeNull();
  });

  it("caps paid boost for an eligible candidate", () => {
    const score = rankCandidate({ eligible: true, preference: 50, interests: 10, activity: 10, boost: 9 });
    expect(score).toBe(85);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/discovery/ranking.test.ts`

Expected: FAIL because ranking is missing.

- [ ] **Step 3: Implement hard filters before scoring**

```ts
// dating-platform/src/modules/discovery/ranking.ts
export function rankCandidate(input: {
  eligible: boolean; preference: number; interests: number; activity: number; boost: number;
}): number | null {
  if (!input.eligible) return null;
  const paidBoost = Math.min(Math.max(input.boost, 0), 1.5) * 10;
  return input.preference + input.interests + input.activity + paidBoost;
}
```

Repository filtering must exclude self, blocked pairs, hidden/restricted accounts, incompatible age/gender preferences, and disallowed regions before applying ranking. Return cursor pagination and `rankingVersion`; do not return internal risk or raw score components.

The saved-search route validates the same public filter schema, stores at most 20 searches per user, supports rename/delete, and never persists an exact coordinate. Discovery modes include recommended, new, nearby, online, and verified; all modes reuse the same hard-filter policy.

- [ ] **Step 4: Verify discovery contracts**

Run: `npm run test -- tests/unit/discovery tests/integration/discovery`

Expected: PASS for hard exclusions, stable cursor pagination, ranking caps, and location privacy.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/modules/discovery dating-platform/src/app/api/v1/discover dating-platform/src/app/[locale]/\(member\)/discover dating-platform/tests
git commit -m "feat: add safe discovery and ranking"
```

### Task 6: Add likes, favorites, matches, views, and blocks

**Files:**
- Create: `dating-platform/src/db/schema/social.ts`
- Create: `dating-platform/src/modules/social/social-service.ts`
- Create: `dating-platform/src/modules/social/social-repository.ts`
- Create: `dating-platform/src/app/api/v1/profiles/[profileId]/like/route.ts`
- Create: `dating-platform/src/app/api/v1/profiles/[profileId]/favorite/route.ts`
- Create: `dating-platform/src/app/api/v1/profiles/[profileId]/view/route.ts`
- Create: `dating-platform/src/app/api/v1/profiles/[profileId]/block/route.ts`
- Create: `dating-platform/src/app/api/v1/matches/route.ts`
- Create: `dating-platform/src/app/api/v1/me/likes/route.ts`
- Create: `dating-platform/src/app/api/v1/me/favorites/route.ts`
- Create: `dating-platform/src/app/api/v1/me/visitors/route.ts`
- Create: `dating-platform/tests/integration/social/match.test.ts`

- [ ] **Step 1: Write a failing reciprocal-like test**

```ts
// dating-platform/tests/integration/social/match.test.ts
import { describe, expect, it } from "vitest";
import { socialTestContext } from "../../support/social-test-context";

describe("likes", () => {
  it("creates exactly one match after reciprocal likes", async () => {
    const ctx = await socialTestContext();
    await ctx.service.like(ctx.alex, ctx.blair, "like-a");
    await ctx.service.like(ctx.blair, ctx.alex, "like-b");
    await ctx.service.like(ctx.blair, ctx.alex, "like-b");
    expect(await ctx.matches()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/integration/social/match.test.ts`

Expected: FAIL because schema/service/test context are absent.

- [ ] **Step 3: Implement transaction and block invariants**

Within one database transaction, upsert the like, check the reverse like, insert the canonical ordered user pair with a unique constraint, and append `match.created` to the outbox. Idempotency keys prevent duplicate writes.

Blocking must atomically create a block, hide existing matches, revoke socket tickets, and prevent future view/like/favorite/message actions in both directions. The blocked user receives no block notification.

- [ ] **Step 4: Verify migrations and social tests**

Run: `npm run db:generate -- --name social_graph && npm run test -- tests/integration/social`

Expected: migration generated; reciprocal, duplicate, concurrent, unblock, and block-isolation tests pass.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/social.ts dating-platform/src/modules/social dating-platform/src/app/api/v1/profiles dating-platform/src/app/api/v1/matches dating-platform/drizzle dating-platform/tests
git commit -m "feat: add social graph and matching"
```

### Task 7: Centralize configurable entitlements and usage limits

**Files:**
- Create: `dating-platform/src/db/schema/entitlements.ts`
- Create: `dating-platform/src/modules/entitlements/types.ts`
- Create: `dating-platform/src/modules/entitlements/entitlement-service.ts`
- Create: `dating-platform/src/modules/entitlements/usage-repository.ts`
- Create: `dating-platform/src/app/api/v1/me/entitlements/route.ts`
- Create: `dating-platform/tests/unit/entitlements/entitlement-service.test.ts`

- [ ] **Step 1: Write failing allowance tests**

```ts
// dating-platform/tests/unit/entitlements/entitlement-service.test.ts
import { describe, expect, it } from "vitest";
import { decideEntitlement } from "@/modules/entitlements/entitlement-service";

describe("decideEntitlement", () => {
  it("reports the remaining daily allowance", () => {
    expect(decideEntitlement({ enabled: true, limit: 5, used: 2, resetAt: "2026-08-06T00:00:00Z" }))
      .toEqual({ allowed: true, remaining: 3, resetAt: "2026-08-06T00:00:00Z", reason: null });
  });

  it("denies a disabled feature", () => {
    expect(decideEntitlement({ enabled: false, limit: null, used: 0, resetAt: null }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/entitlements/entitlement-service.test.ts`

Expected: FAIL because the entitlement service is missing.

- [ ] **Step 3: Implement deterministic decisions**

```ts
// dating-platform/src/modules/entitlements/entitlement-service.ts
export function decideEntitlement(input: {
  enabled: boolean; limit: number | null; used: number; resetAt: string | null;
}) {
  if (!input.enabled) return { allowed: false, remaining: 0, resetAt: input.resetAt, reason: "DISABLED" };
  if (input.limit === null) return { allowed: true, remaining: null, resetAt: input.resetAt, reason: null };
  const remaining = Math.max(input.limit - input.used, 0);
  return { allowed: remaining > 0, remaining, resetAt: input.resetAt, reason: remaining > 0 ? null : "LIMIT_REACHED" };
}
```

Resolve rules in order: safety/verification requirement, global feature flag, user exception, active plan, free default. Use Redis only as a cache; PostgreSQL remains authoritative. Consumption uses a transaction and unique operation ID.

- [ ] **Step 4: Verify free defaults and race safety**

Run: `npm run test -- tests/unit/entitlements tests/integration/entitlements`

Expected: PASS for unlimited free defaults, plan overrides, expiry, concurrent consumption, and cache miss.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/entitlements.ts dating-platform/src/modules/entitlements dating-platform/src/app/api/v1/me/entitlements dating-platform/tests
git commit -m "feat: add configurable entitlement engine"
```

### Task 8: Persist conversations and issue short-lived socket tickets

**Files:**
- Create: `dating-platform/src/db/schema/messaging.ts`
- Create: `dating-platform/src/modules/messaging/message-service.ts`
- Create: `dating-platform/src/modules/messaging/message-repository.ts`
- Create: `dating-platform/src/modules/messaging/socket-ticket.ts`
- Create: `dating-platform/src/app/api/v1/conversations/route.ts`
- Create: `dating-platform/src/app/api/v1/conversations/[conversationId]/messages/route.ts`
- Create: `dating-platform/src/app/api/v1/realtime/ticket/route.ts`
- Create: `dating-platform/tests/integration/messaging/message-idempotency.test.ts`

- [ ] **Step 1: Write a failing idempotent-message test**

```ts
// dating-platform/tests/integration/messaging/message-idempotency.test.ts
import { describe, expect, it } from "vitest";
import { messagingTestContext } from "../../support/messaging-test-context";

describe("send message", () => {
  it("stores one message for a retried client id", async () => {
    const ctx = await messagingTestContext();
    await ctx.send({ clientId: "client-1", body: "Hello" });
    await ctx.send({ clientId: "client-1", body: "Hello" });
    expect(await ctx.messages()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/integration/messaging/message-idempotency.test.ts`

Expected: FAIL because messaging persistence is absent.

- [ ] **Step 3: Implement persistent send and socket ticket signing**

The send transaction must verify membership, block status, verification policy, and `message.send.daily`; insert by unique `(sender_id, client_id)`; allocate a conversation sequence; append `message.created`; then consume entitlement usage.

Socket tickets are five-minute JWTs signed by a dedicated rotating key and contain only `sub`, `sessionId`, `aud: realtime`, and `exp`. The real-time server never accepts a user ID supplied by the client.

- [ ] **Step 4: Verify messaging contracts**

Run: `npm run db:generate -- --name messaging && npm run test -- tests/integration/messaging tests/unit/messaging`

Expected: PASS for idempotency, membership, blocking, entitlement denial, sequence order, and expired tickets.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/messaging.ts dating-platform/src/modules/messaging dating-platform/src/app/api/v1/conversations dating-platform/src/app/api/v1/realtime dating-platform/drizzle dating-platform/tests
git commit -m "feat: add persistent messaging contracts"
```

### Task 9: Deliver messages through the real-time process

**Files:**
- Create: `dating-platform/realtime/server.ts`
- Create: `dating-platform/realtime/authenticate-socket.ts`
- Create: `dating-platform/realtime/outbox-consumer.ts`
- Create: `dating-platform/src/modules/messaging/realtime-client.ts`
- Create: `dating-platform/src/app/[locale]/(member)/messages/page.tsx`
- Create: `dating-platform/tests/integration/realtime/delivery.test.ts`

- [ ] **Step 1: Write the failing delivery/reconnect test**

Create a test that connects two authenticated clients, sends through the HTTP message service, observes one `message.created` event, disconnects the recipient, sends another message, reconnects with the last sequence, and receives only the missed event.

Run: `npm run test -- tests/integration/realtime/delivery.test.ts`

Expected: FAIL because the real-time process is missing.

- [ ] **Step 2: Implement authenticated rooms and outbox consumption**

`authenticate-socket.ts` verifies signature, audience, expiry, session revocation, and account status. Join `user:{id}` and authorized `conversation:{id}` rooms. `outbox-consumer.ts` claims events with `FOR UPDATE SKIP LOCKED`, emits them, and marks them delivered; retries use exponential backoff.

- [ ] **Step 3: Implement cursor-based recovery and receipts**

On reconnect, the client calls the messages API with `afterSequence`. Delivery and read receipts use idempotent upserts and never decrease. The page preserves unsent drafts locally and clearly displays connecting, online, retrying, and failed states.

- [ ] **Step 4: Run real-time and messaging suites**

Run: `npm run test -- tests/integration/realtime tests/integration/messaging`

Expected: PASS with one delivery per message, ordered recovery, invalid-ticket rejection, and block-triggered disconnect.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/realtime dating-platform/src/modules/messaging/realtime-client.ts dating-platform/src/app/[locale]/\(member\)/messages dating-platform/tests/integration/realtime
git commit -m "feat: add reliable real-time delivery"
```

### Task 10: Add reporting, risk signals, moderation, and appeals

**Files:**
- Create: `dating-platform/src/db/schema/moderation.ts`
- Create: `dating-platform/src/modules/moderation/report-service.ts`
- Create: `dating-platform/src/modules/moderation/case-service.ts`
- Create: `dating-platform/src/modules/moderation/risk-policy.ts`
- Create: `dating-platform/src/app/api/v1/reports/route.ts`
- Create: `dating-platform/src/app/api/v1/me/reports/route.ts`
- Create: `dating-platform/tests/unit/moderation/risk-policy.test.ts`

- [ ] **Step 1: Write the failing emergency-risk test**

```ts
// dating-platform/tests/unit/moderation/risk-policy.test.ts
import { describe, expect, it } from "vitest";
import { triageReport } from "@/modules/moderation/risk-policy";

describe("triageReport", () => {
  it("isolates suspected child-safety content immediately", () => {
    expect(triageReport({ reason: "MINOR_SAFETY", confidence: 0.9 }))
      .toEqual({ priority: "emergency", temporaryRestriction: true, preserveEvidence: true });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/moderation/risk-policy.test.ts`

Expected: FAIL because the risk policy is missing.

- [ ] **Step 3: Implement report and case state machines**

Reports accept a fixed reason code, localized explanation, target snapshot, optional message references, and evidence objects. Only case workers can move `submitted → triaged → under_review → actioned|dismissed`; appeals create a separate review and final decision. High-impact actions require reason, evidence summary, operator, and expiry.

Child-safety handling must isolate content, preserve access-controlled evidence, alert the designated safety role, and invoke a jurisdiction-configured legal workflow. General administrators cannot browse isolated evidence.

- [ ] **Step 4: Verify governance behavior**

Run: `npm run db:generate -- --name moderation && npm run test -- tests/unit/moderation tests/integration/moderation`

Expected: PASS for report ownership, duplicate suppression, emergency restriction, operator permissions, appeal separation, and audit append.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/moderation.ts dating-platform/src/modules/moderation dating-platform/src/app/api/v1/reports dating-platform/src/app/api/v1/me/reports dating-platform/drizzle dating-platform/tests
git commit -m "feat: add report and moderation workflows"
```

### Task 11: Implement plans, subscriptions, Stripe webhooks, and reconciliation

**Files:**
- Create: `dating-platform/src/db/schema/billing.ts`
- Create: `dating-platform/src/modules/billing/stripe-adapter.ts`
- Create: `dating-platform/src/modules/billing/checkout-service.ts`
- Create: `dating-platform/src/modules/billing/webhook-service.ts`
- Create: `dating-platform/src/modules/billing/reconciliation-service.ts`
- Create: `dating-platform/src/app/api/v1/plans/route.ts`
- Create: `dating-platform/src/app/api/v1/checkout-sessions/route.ts`
- Create: `dating-platform/src/app/api/v1/webhooks/payment/stripe/route.ts`
- Create: `dating-platform/tests/integration/billing/webhook-idempotency.test.ts`

- [ ] **Step 1: Write the failing duplicate-webhook test**

```ts
// dating-platform/tests/integration/billing/webhook-idempotency.test.ts
import { describe, expect, it } from "vitest";
import { billingTestContext } from "../../support/billing-test-context";

describe("Stripe webhook", () => {
  it("applies a paid invoice once", async () => {
    const ctx = await billingTestContext();
    await ctx.handle(ctx.invoicePaid("evt_1"));
    await ctx.handle(ctx.invoicePaid("evt_1"));
    expect(await ctx.paymentCount()).toBe(1);
    expect(await ctx.activeSubscriptionCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/integration/billing/webhook-idempotency.test.ts`

Expected: FAIL because billing services are missing.

- [ ] **Step 3: Implement server-authoritative billing**

Checkout selects a server-stored active price by country/currency and creates a pending order before calling Stripe. The webhook route reads the raw body, verifies the Stripe signature, inserts the event ID with a unique constraint, and maps subscription/invoice/refund/dispute events to internal state in one transaction.

Entitlements refresh only after committed internal subscription state. Reconciliation compares active internal subscriptions, recent invoices, refunds, and disputes against Stripe and creates reviewable discrepancies; it never silently edits historical payments.

- [ ] **Step 4: Run billing and entitlement suites**

Run: `npm run db:generate -- --name billing && npm run test -- tests/integration/billing tests/unit/entitlements`

Expected: PASS for signature rejection, duplicate events, out-of-order events, refunds, disputes, grace period, and free-default behavior.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/billing.ts dating-platform/src/modules/billing dating-platform/src/app/api/v1/plans dating-platform/src/app/api/v1/checkout-sessions dating-platform/src/app/api/v1/webhooks dating-platform/drizzle dating-platform/tests
git commit -m "feat: add subscription billing and reconciliation"
```

### Task 12: Build the RBAC operations console and audited configuration

**Files:**
- Create: `dating-platform/src/db/schema/admin.ts`
- Create: `dating-platform/src/modules/admin/permissions.ts`
- Create: `dating-platform/src/modules/admin/audit-service.ts`
- Create: `dating-platform/src/modules/admin/admin-service.ts`
- Create: `dating-platform/src/app/api/v1/admin/users/[userId]/actions/route.ts`
- Create: `dating-platform/src/app/api/v1/admin/entitlements/route.ts`
- Create: `dating-platform/src/app/[locale]/admin/page.tsx`
- Create: `dating-platform/tests/integration/admin/permissions.test.ts`

- [ ] **Step 1: Write the failing least-privilege test**

```ts
// dating-platform/tests/integration/admin/permissions.test.ts
import { describe, expect, it } from "vitest";
import { can } from "@/modules/admin/permissions";

describe("admin permissions", () => {
  it("does not let finance read private messages", () => {
    expect(can("finance", "message.read_private")).toBe(false);
  });

  it("lets moderators decide ordinary reports", () => {
    expect(can("moderator", "case.decide")).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/integration/admin/permissions.test.ts`

Expected: FAIL because permission mapping is missing.

- [ ] **Step 3: Implement RBAC, step-up authentication, and append-only audit**

Define explicit permissions for support, moderation, safety, operations, finance, and super-admin roles. Every admin route calls `requireAdminSession`, `requirePermission`, and `requireRecentMfa` for sensitive actions. Audit records contain actor, permission, target type/id, before/after redacted diffs, reason, request ID, IP hash, and timestamp.

Bulk suspension, sensitive export, manual refund, payment configuration, and safety-evidence access require a second approver. The console must expose queues for profile media, reports, appeals, billing discrepancies, verification failures, and configuration changes.

- [ ] **Step 4: Verify admin boundaries**

Run: `npm run db:generate -- --name admin_rbac && npm run test -- tests/integration/admin tests/unit/admin`

Expected: PASS for role matrix, recent-MFA requirement, dual approval, redacted audit, and unauthorized access denial.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/db/schema/admin.ts dating-platform/src/modules/admin dating-platform/src/app/api/v1/admin dating-platform/src/app/[locale]/admin dating-platform/drizzle dating-platform/tests
git commit -m "feat: add audited operations console"
```

### Task 13: Add bilingual UX, notifications, privacy export, and deletion

**Files:**
- Create: `dating-platform/messages/en.json`
- Create: `dating-platform/messages/zh-CN.json`
- Create: `dating-platform/src/i18n/request.ts`
- Create: `dating-platform/src/modules/notifications/notification-router.ts`
- Create: `dating-platform/src/modules/profiles/data-export-service.ts`
- Create: `dating-platform/src/modules/profiles/deletion-service.ts`
- Create: `dating-platform/src/app/api/v1/me/export/route.ts`
- Create: `dating-platform/src/app/api/v1/me/delete/route.ts`
- Create: `dating-platform/tests/unit/profiles/deletion-service.test.ts`

- [ ] **Step 1: Write the failing deletion-retention test**

```ts
// dating-platform/tests/unit/profiles/deletion-service.test.ts
import { describe, expect, it } from "vitest";
import { deletionSchedule } from "@/modules/profiles/deletion-service";

describe("deletionSchedule", () => {
  it("uses a 30-day cooling period and preserves legal holds", () => {
    expect(deletionSchedule(new Date("2026-08-05T00:00:00Z"), true)).toEqual({
      executeAt: new Date("2026-09-04T00:00:00.000Z"),
      preserveHeldRecords: true,
    });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/profiles/deletion-service.test.ts`

Expected: FAIL because deletion service is missing.

- [ ] **Step 3: Implement locale completeness and privacy jobs**

All user-facing strings use translation keys; CI compares English and Chinese key sets. Notification routing respects transactional/marketing category, locale, channel consent, quiet hours, and provider fallback.

Export creates an encrypted archive asynchronously and sends a short-lived authenticated download link. Deletion revokes sessions immediately, hides the profile, starts cooling-off, cancels renewal, then anonymizes eligible data while moving legally held records to restricted retention.

- [ ] **Step 4: Verify i18n and privacy behavior**

Run: `npm run test -- tests/unit/profiles tests/unit/notifications tests/contract/i18n`

Expected: PASS for matching locale keys, marketing opt-out, required security notice, export ownership, cancellation, cooling-off, and legal holds.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/messages dating-platform/src/i18n dating-platform/src/modules/notifications dating-platform/src/modules/profiles dating-platform/src/app/api/v1/me dating-platform/tests
git commit -m "feat: add localization and privacy workflows"
```

### Task 14: Add structured errors, tracing, rate limits, and security checks

**Files:**
- Create: `dating-platform/src/shared/app-error.ts`
- Create: `dating-platform/src/shared/error-response.ts`
- Create: `dating-platform/src/infrastructure/observability/tracing.ts`
- Create: `dating-platform/src/infrastructure/security/rate-limit.ts`
- Create: `dating-platform/src/instrumentation.ts`
- Create: `dating-platform/tests/unit/shared/error-response.test.ts`
- Create: `dating-platform/tests/integration/security/rate-limit.test.ts`

- [ ] **Step 1: Write the failing safe-error test**

```ts
// dating-platform/tests/unit/shared/error-response.test.ts
import { describe, expect, it } from "vitest";
import { toErrorResponse } from "@/shared/error-response";

describe("toErrorResponse", () => {
  it("hides internal errors and returns a trace id", () => {
    expect(toErrorResponse(new Error("password table unavailable"), "trace-1")).toEqual({
      status: 500,
      body: { code: "INTERNAL_ERROR", messageKey: "errors.internal", retryable: true, traceId: "trace-1" },
    });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/unit/shared/error-response.test.ts`

Expected: FAIL because safe error mapping is absent.

- [ ] **Step 3: Implement shared error and telemetry middleware**

Map stable application errors to HTTP status, translation key, field errors, retryability, and trace ID. Log structured redacted context server-side. Instrument HTTP, database, queue, real-time, payment, media, and moderation spans; metrics must not contain email, phone, message text, or exact location.

Implement named Redis token buckets for login, verification, search, profile views, likes, messages, reports, uploads, and payment endpoints. A Redis outage fails closed for authentication/payment and uses conservative in-process limits for browsing.

- [ ] **Step 4: Run quality and security gates**

Run: `npm run test -- tests/unit/shared tests/integration/security && npm audit --audit-level=high && npm run build`

Expected: tests pass, no high-severity unresolved advisory, and production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add dating-platform/src/shared dating-platform/src/infrastructure dating-platform/src/instrumentation.ts dating-platform/tests
git commit -m "feat: add security and observability baseline"
```

### Task 15: Complete end-to-end acceptance, recovery checks, and release documentation

**Files:**
- Create: `dating-platform/tests/e2e/member-journey.spec.ts`
- Create: `dating-platform/tests/e2e/admin-moderation.spec.ts`
- Create: `dating-platform/tests/e2e/subscription.spec.ts`
- Create: `dating-platform/tests/e2e/accessibility.spec.ts`
- Create: `dating-platform/scripts/seed-e2e.ts`
- Create: `dating-platform/scripts/verify-backup-restore.ts`
- Create: `dating-platform/docs/runbooks/incident-response.md`
- Create: `dating-platform/docs/runbooks/payment-reconciliation.md`
- Create: `dating-platform/docs/runbooks/moderation-escalation.md`
- Create: `dating-platform/docs/release-checklist.md`

- [ ] **Step 1: Write complete Playwright acceptance journeys**

`member-journey.spec.ts` must register two adults, verify email/phone with test adapters, complete profiles, approve photos through the test moderator, discover each other, like, match, exchange a message, verify reconnect recovery, block, and confirm interaction denial.

`subscription.spec.ts` must open checkout, use Stripe test mode, replay the signed fixture webhook, confirm entitlements, cancel renewal, simulate a refund, and confirm entitlement recalculation.

`admin-moderation.spec.ts` must report a message, triage it, impose a temporary restriction, appeal from the member account, finalize with a second moderator, and verify the audit timeline.

- [ ] **Step 2: Run acceptance tests and capture failures**

Run: `npm run test:e2e`

Expected before the final fixes: any failure identifies a specific user-visible gap; no test may be skipped.

- [ ] **Step 3: Fix acceptance gaps and verify accessibility**

Run: `npm run test:e2e && npm run check`

Expected: all unit, integration, contract, end-to-end, lint, and build checks pass. Accessibility tests cover keyboard navigation, focus, names/roles, error association, contrast, reduced motion, and English/Chinese overflow.

- [ ] **Step 4: Verify backup recovery and operational runbooks**

Run: `npm run db:backup:test && npm run db:restore:verify`

Expected: a temporary restored database passes row-count, foreign-key, recent-message, subscription, and audit-log checks; the script prints measured RPO/RTO and removes only its verified temporary resources.

Document exact alert ownership, incident severity, payment reconciliation, emergency moderation, vendor outage, rollback, data export, deletion, and legal-hold procedures. `release-checklist.md` must include environment validation, migrations, key rotation readiness, Stripe endpoint verification, admin MFA, smoke tests, rollback, and monitoring sign-off.

- [ ] **Step 5: Final verification and commit**

Run: `npm run check && npm run test:e2e && npx drizzle-kit check`

Expected: all commands exit 0 with no skipped acceptance tests or migration conflicts.

```bash
git add dating-platform/tests/e2e dating-platform/scripts dating-platform/docs dating-platform/package.json
git commit -m "test: complete dating platform release gates"
```

## Final handoff checklist

- Every P0 requirement in the approved design maps to at least one task above.
- A production deployment cannot proceed with skipped acceptance tests, unresolved high-severity vulnerabilities, failed Stripe reconciliation, missing administrator MFA, or an unverified backup restore.
- Core features remain free through seeded entitlement configuration; operations can enable paid restrictions without code changes.
- Native apps, video/live features, virtual currency, virtual gifts, transfers, withdrawals, and AI auto-chat remain outside this implementation plan.
