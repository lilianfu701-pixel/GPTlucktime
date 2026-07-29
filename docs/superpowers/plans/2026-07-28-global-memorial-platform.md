# Global Memorial Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-oriented, multilingual memorial platform foundation where verified close family members can create searchable memorials and configure culturally appropriate commemorations.

**Architecture:** Create a new `memorial-platform/` Next.js modular monolith beside the unrelated `fantasy5-site/`. Keep domain code in focused `modules/` packages, expose mutations through route handlers and server actions, store transactional data in PostgreSQL through Drizzle, use Redis-backed jobs for asynchronous work, and keep media behind an S3-compatible adapter.

**Tech Stack:** Node.js 22, TypeScript 5.9, Next.js 16, React 19, PostgreSQL 17, Drizzle ORM, Vitest, Playwright, next-intl, Zod, Redis, S3-compatible storage, OpenTelemetry.

**Design source:** `docs/superpowers/specs/2026-07-28-global-memorial-platform-design.md`

---

## 1. Delivery boundaries

This plan produces five independently testable milestones:

1. Platform foundation and hidden phone authentication.
2. Memorial creation, collaboration, privacy, content and media.
3. Religion/culture catalog and family-controlled commemorations.
4. Search, duplicate detection, reports and ownership disputes.
5. Entitlement reservation, admin operations, hardening and launch validation.

Do not add payment processing, native applications, microservices, public popularity rankings, government death-registration integrations, or AI-authored religious doctrine.

## 2. Target file map

```text
memorial-platform/
├── app/
│   ├── [locale]/
│   │   ├── (auth)/sign-in/page.tsx
│   │   ├── (dashboard)/dashboard/page.tsx
│   │   ├── memorials/new/page.tsx
│   │   ├── memorials/[slug]/page.tsx
│   │   └── layout.tsx
│   ├── api/
│   │   ├── auth/email/request/route.ts
│   │   ├── auth/email/verify/route.ts
│   │   ├── auth/phone/request/route.ts
│   │   ├── auth/phone/verify/route.ts
│   │   ├── memorials/route.ts
│   │   ├── memorials/[id]/privacy/route.ts
│   │   ├── memorials/[id]/commemorations/route.ts
│   │   ├── media/sign/route.ts
│   │   ├── reports/route.ts
│   │   └── search/route.ts
│   ├── robots.ts
│   ├── sitemap.ts
│   └── layout.tsx
├── db/
│   ├── client.ts
│   ├── schema/
│   │   ├── identity.ts
│   │   ├── memorial.ts
│   │   ├── content.ts
│   │   ├── religion.ts
│   │   ├── commemoration.ts
│   │   ├── governance.ts
│   │   ├── commerce.ts
│   │   └── index.ts
│   └── seed/religions.ts
├── modules/
│   ├── auth/
│   ├── memorials/
│   ├── permissions/
│   ├── religion/
│   ├── commemorations/
│   ├── media/
│   ├── search/
│   ├── governance/
│   ├── entitlements/
│   └── audit/
├── lib/
│   ├── env.ts
│   ├── errors.ts
│   ├── feature-flags.ts
│   ├── locale.ts
│   ├── observability.ts
│   └── result.ts
├── messages/
│   ├── en.json
│   ├── es.json
│   └── zh-CN.json
├── worker/
│   ├── index.ts
│   └── jobs/
├── tests/
│   ├── integration/
│   ├── unit/
│   └── e2e/
├── drizzle.config.ts
├── middleware.ts
├── next.config.ts
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── vitest.config.ts
```

Each schema file owns one domain. Route handlers validate transport input and call domain services; they do not query Drizzle directly. Domain services accept an explicit actor and return typed results. Cross-domain changes emit an outbox record in the same database transaction.

## 3. Global conventions

Use these shared types from the beginning:

```ts
// lib/result.ts
export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// modules/permissions/types.ts
export type Actor = {
  userId: string | null;
  platformRole: "user" | "reviewer" | "super_admin";
};

export type MemorialRole =
  | "owner"
  | "admin"
  | "editor"
  | "reviewer"
  | "invited_visitor";
```

Every externally supplied ID is parsed as UUID. Every mutation accepts or derives an idempotency key. All timestamps are `timestamp with time zone`; services use UTC. Public error responses contain stable codes and never leak stack traces.

## 4. Task plan

### Task 1: Scaffold the isolated application

**Files:**
- Create: `memorial-platform/package.json`
- Create: `memorial-platform/tsconfig.json`
- Create: `memorial-platform/next.config.ts`
- Create: `memorial-platform/app/layout.tsx`
- Create: `memorial-platform/app/page.tsx`
- Create: `memorial-platform/.env.example`
- Create: `memorial-platform/.gitignore`

- [ ] **Step 1: Write the scaffold smoke test**

Create `memorial-platform/tests/unit/scaffold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("application scaffold", () => {
  it("pins the supported runtime and scripts", () => {
    expect(packageJson.engines.node).toBe(">=22.13.0");
    expect(packageJson.scripts).toMatchObject({
      test: "vitest run",
      "test:e2e": "playwright test",
      build: "next build",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
    });
  });
});
```

- [ ] **Step 2: Create `package.json` and install pinned dependencies**

Use this package definition:

```json
{
  "name": "global-memorial-platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:seed": "tsx db/seed/index.ts",
    "worker": "tsx worker/index.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "3.910.0",
    "@aws-sdk/s3-request-presigner": "3.910.0",
    "drizzle-orm": "0.45.2",
    "ioredis": "5.8.1",
    "jose": "6.1.0",
    "next": "16.2.6",
    "next-intl": "4.3.12",
    "pg": "8.16.3",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "zod": "4.1.12"
  },
  "devDependencies": {
    "@playwright/test": "1.56.1",
    "@types/node": "22.19.19",
    "@types/pg": "8.15.5",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "drizzle-kit": "0.31.10",
    "eslint": "9.39.4",
    "eslint-config-next": "16.2.6",
    "tsx": "4.20.6",
    "typescript": "5.9.3",
    "vitest": "4.0.3"
  }
}
```

Run: `cd memorial-platform && npm install`  
Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 3: Add strict TypeScript, Next.js config, root layout and health page**

The root page must render `Memorial platform is running`. Set `reactStrictMode: true`; set security headers for `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.

- [ ] **Step 4: Run the verification commands**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all four commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add memorial-platform
git commit -m "chore: scaffold memorial platform"
```

### Task 2: Add deterministic test infrastructure and environment validation

**Files:**
- Create: `memorial-platform/vitest.config.ts`
- Create: `memorial-platform/playwright.config.ts`
- Create: `memorial-platform/tests/setup.ts`
- Create: `memorial-platform/lib/env.ts`
- Create: `memorial-platform/lib/result.ts`
- Create: `memorial-platform/lib/errors.ts`
- Test: `memorial-platform/tests/unit/env.test.ts`

- [ ] **Step 1: Write failing environment tests**

```ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/memorial_test",
  REDIS_URL: "redis://localhost:6379/1",
  APP_URL: "http://localhost:3000",
  SESSION_SECRET: "12345678901234567890123456789012",
  S3_BUCKET: "memorial-test",
  S3_REGION: "us-west-2",
};

describe("parseEnv", () => {
  it("accepts complete configuration", () => {
    expect(parseEnv(valid).DATABASE_URL).toContain("postgres://");
  });

  it("rejects a short session secret", () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: "short" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `npm test -- tests/unit/env.test.ts`  
Expected: FAIL because `@/lib/env` does not exist.

- [ ] **Step 3: Implement `parseEnv` with Zod**

Define exact fields from the test plus optional S3 endpoint, email provider, SMS provider, Google credentials and Apple credentials. Export `parseEnv(input)` and lazily evaluated `env()` so importing modules does not crash test discovery.

- [ ] **Step 4: Configure aliases and test isolation**

Set Vitest environment to `node`, alias `@` to the application root, load `tests/setup.ts`, disable test concurrency for database integration files, and configure Playwright to start `npm run dev`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/unit/env.test.ts && npm run typecheck`  
Expected: PASS.

```bash
git add memorial-platform/lib memorial-platform/tests memorial-platform/vitest.config.ts memorial-platform/playwright.config.ts memorial-platform/tsconfig.json
git commit -m "test: add validated memorial test foundation"
```

### Task 3: Create PostgreSQL connection, migrations and transactional outbox

**Files:**
- Create: `memorial-platform/db/client.ts`
- Create: `memorial-platform/db/schema/system.ts`
- Create: `memorial-platform/db/schema/index.ts`
- Create: `memorial-platform/drizzle.config.ts`
- Create: `memorial-platform/tests/integration/db.test.ts`

- [ ] **Step 1: Write a failing transaction test**

Test that inserting an audit event and outbox event inside `db.transaction()` persists both, and throwing after the first insert persists neither. Use a unique test correlation ID and clean up only rows carrying that ID.

- [ ] **Step 2: Run the integration test**

Run: `npm test -- tests/integration/db.test.ts`  
Expected: FAIL because the client and tables do not exist.

- [ ] **Step 3: Add system tables**

Define:

```ts
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id"),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  reason: text("reason"),
  correlationId: text("correlation_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  topic: text("topic").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 4: Generate and apply migration**

Run:

```bash
npm run db:generate
npm run db:migrate
npm test -- tests/integration/db.test.ts
```

Expected: migration succeeds and both transaction cases pass.

- [ ] **Step 5: Commit**

```bash
git add memorial-platform/db memorial-platform/drizzle memorial-platform/drizzle.config.ts memorial-platform/tests/integration/db.test.ts
git commit -m "feat: add transactional database foundation"
```

### Task 4: Implement identity, sessions and hidden phone authentication

**Files:**
- Create: `memorial-platform/db/schema/identity.ts`
- Create: `memorial-platform/modules/auth/service.ts`
- Create: `memorial-platform/modules/auth/otp-store.ts`
- Create: `memorial-platform/modules/auth/providers/email.ts`
- Create: `memorial-platform/modules/auth/providers/sms.ts`
- Create: `memorial-platform/modules/auth/providers/oauth.ts`
- Create: `memorial-platform/lib/feature-flags.ts`
- Create: four auth route handlers under `app/api/auth/`
- Test: `memorial-platform/tests/integration/auth.test.ts`
- Test: `memorial-platform/tests/e2e/phone-hidden.spec.ts`

- [ ] **Step 1: Write failing identity tests**

Cover:

- normalized emails are unique;
- phone numbers must be valid E.164;
- OTP expires after ten minutes;
- a sixth wrong OTP attempt locks the challenge;
- phone routes return `FEATURE_DISABLED` when the global flag is false;
- Google and Apple callbacks reject mismatched state and link only verified provider emails;
- direct rendering of `/en/sign-in` contains no phone input when disabled.

- [ ] **Step 2: Add identity schema**

Create `users`, `user_identities`, `email_credentials`, `phone_credentials`, `sessions`, and `login_attempts`. Store OTP hashes, never plaintext OTPs. Hash session tokens before storage. Add unique indexes for normalized email and E.164 phone identity.

- [ ] **Step 3: Implement provider interfaces**

```ts
export interface EmailProvider {
  sendLoginCode(input: { to: string; code: string; locale: string }): Promise<void>;
}

export interface SmsProvider {
  sendLoginCode(input: { toE164: string; code: string; locale: string }): Promise<void>;
}
```

Production adapters read provider configuration from `env()`. Tests use in-memory fakes that expose the last code. Rate-limit by normalized destination and IP.

Define the OAuth adapter as:

```ts
export interface OAuthProvider {
  createAuthorizationUrl(input: { state: string; nonce: string; locale: string }): URL;
  verifyCallback(input: { code: string; state: string; expectedState: string; nonce: string }):
    Promise<{ providerSubject: string; email: string; emailVerified: boolean }>;
}
```

Store Google and Apple identities by provider subject. Never merge an account from an unverified provider email; require an authenticated account-linking flow instead.

- [ ] **Step 4: Implement routes and the disabled UI**

Phone routes exist and are tested, but check `phoneAuthEnabled()` before sending or verifying. The sign-in page renders phone controls only when the server-side feature flag is true.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/integration/auth.test.ts
npx playwright test tests/e2e/phone-hidden.spec.ts
npm run typecheck
```

Expected: OTP behavior passes and phone controls are absent.

- [ ] **Step 6: Commit**

```bash
git add memorial-platform
git commit -m "feat: add identity and hidden phone authentication"
```

### Task 5: Add locale routing and the first three complete interface catalogs

**Files:**
- Create: `memorial-platform/lib/locale.ts`
- Create: `memorial-platform/middleware.ts`
- Create: `memorial-platform/app/[locale]/layout.tsx`
- Create: `memorial-platform/messages/en.json`
- Create: `memorial-platform/messages/es.json`
- Create: `memorial-platform/messages/zh-CN.json`
- Create: `memorial-platform/messages/ar.json`
- Test: `memorial-platform/tests/unit/locale.test.ts`
- Test: `memorial-platform/tests/e2e/rtl.spec.ts`

- [ ] **Step 1: Write failing locale tests**

Assert:

- supported launch locales are `en`, `es`, `zh-CN`;
- architecture-recognized locales also include `pt-BR`, `pt-PT`, `fr`, `de`, `ar`, `zh-TW`, `zh-HK`, `ja`, `ru`, `id`, `vi`, `ko`;
- `ar` produces `dir="rtl"`;
- unsupported locale falls back to `en`;
- the three launch catalogs contain identical message keys.

- [ ] **Step 2: Implement locale helpers and routing**

Export `launchLocales`, `recognizedLocales`, `normalizeLocale`, and `textDirection`. Middleware redirects `/` to the negotiated locale and never localizes `/api`.

- [ ] **Step 3: Add complete launch catalogs**

Create matching keys for navigation, authentication, memorial creation, privacy, religious selection, ritual actions, moderation, errors and accessibility labels. `ar.json` may contain engineering-validation strings only and must not be presented as a launch-complete catalog.

- [ ] **Step 4: Verify RTL**

Run: `npx playwright test tests/e2e/rtl.spec.ts`  
Expected: `<html lang="ar" dir="rtl">` and no horizontal overflow at 375px width.

- [ ] **Step 5: Commit**

```bash
git add memorial-platform/app memorial-platform/lib/locale.ts memorial-platform/messages memorial-platform/middleware.ts memorial-platform/tests
git commit -m "feat: add multilingual locale foundation"
```

### Task 6: Implement memorial records, relationship claims and membership permissions

**Files:**
- Create: `memorial-platform/db/schema/memorial.ts`
- Create: `memorial-platform/modules/memorials/service.ts`
- Create: `memorial-platform/modules/permissions/policy.ts`
- Create: `memorial-platform/modules/permissions/types.ts`
- Create: `memorial-platform/app/api/memorials/route.ts`
- Test: `memorial-platform/tests/unit/permissions.test.ts`
- Test: `memorial-platform/tests/integration/memorial-create.test.ts`

- [ ] **Step 1: Write the permission matrix test**

Use table-driven cases for owner, admin, editor, reviewer, invited visitor, public visitor, platform reviewer and super admin across `edit_profile`, `change_privacy`, `manage_members`, `publish_content`, `moderate_submission`, and `delete_memorial`.

- [ ] **Step 2: Add memorial schema**

Create `deceased_people`, `memorials`, `memorial_names`, `memorial_locations`, `memorial_members`, `relationship_claims`, and `memorial_privacy`. Restrict relationship claims to `spouse`, `parent`, `child`, and `sibling`. Store date precision as `day`, `month`, `year`, `approximate`, or `unknown`.

- [ ] **Step 3: Implement `createMemorial`**

Signature:

```ts
export async function createMemorial(
  actor: Actor,
  input: CreateMemorialInput,
  idempotencyKey: string,
): Promise<Result<{ memorialId: string; slug: string }, CreateMemorialError>>;
```

Validate the actor, relationship, names and dates; create the deceased record, default-public memorial, owner membership, relationship claim, audit entry and `memorial.created` outbox event in one transaction.

- [ ] **Step 4: Add POST `/api/memorials`**

Validate with Zod, require `Idempotency-Key`, derive actor from the session, return `201` on first creation and the same resource on retry.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- tests/unit/permissions.test.ts tests/integration/memorial-create.test.ts
npm run db:generate
npm run db:migrate
```

Expected: all cases pass.

```bash
git add memorial-platform
git commit -m "feat: create family-owned memorial records"
```

### Task 7: Implement privacy modes, invitations and access enforcement

**Files:**
- Create: `memorial-platform/modules/memorials/access.ts`
- Create: `memorial-platform/modules/memorials/privacy.ts`
- Create: `memorial-platform/app/api/memorials/[id]/privacy/route.ts`
- Create: `memorial-platform/modules/memorials/invitations.ts`
- Test: `memorial-platform/tests/integration/privacy.test.ts`

- [ ] **Step 1: Write failing privacy tests**

Cover anonymous, linked and invited access for `public`, `unlisted`, and `invite_only`; verify only the owner can change privacy; verify public-to-private changes enqueue `search.remove`; verify private-to-public requires `confirmPublicExposure: true`.

- [ ] **Step 2: Implement central access evaluation**

```ts
export type AccessDecision =
  | { allowed: true; role: MemorialRole | "public_visitor" }
  | { allowed: false; reason: "NOT_FOUND" | "INVITATION_REQUIRED" | "FORBIDDEN" };
```

Return `NOT_FOUND` for unauthorized access to invite-only resources to avoid disclosing their existence.

- [ ] **Step 3: Implement atomic privacy changes**

Update privacy, append audit log and outbox event in one transaction. Routes set `Cache-Control: private, no-store` for invite-only content.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/integration/privacy.test.ts`  
Expected: all privacy transitions and access cases pass.

```bash
git add memorial-platform
git commit -m "feat: enforce memorial privacy and invitations"
```

### Task 8: Add biographies, timeline entries, tributes and content translations

**Files:**
- Create: `memorial-platform/db/schema/content.ts`
- Create: `memorial-platform/modules/memorials/content-service.ts`
- Create: `memorial-platform/modules/memorials/translation-service.ts`
- Test: `memorial-platform/tests/integration/content.test.ts`

- [ ] **Step 1: Write failing content tests**

Verify editors can create drafts, owners/admins can publish, reviewers cannot rewrite biographies, original text is immutable across translations, machine translations are labeled, and rejected visitor submissions never enter public queries.

- [ ] **Step 2: Add content tables**

Create `biographies`, `timeline_events`, `tributes`, `visitor_submissions`, `content_versions`, and `content_translations`. Store `sourceLocale`, translation method (`human` or `machine`), reviewer ID and status.

- [ ] **Step 3: Implement versioned publishing**

Every edit appends a version record. Publishing updates the visible version pointer. Translation failure returns the original content instead of an empty response.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/integration/content.test.ts`  
Expected: permission, version and translation cases pass.

```bash
git add memorial-platform
git commit -m "feat: add versioned memorial content"
```

### Task 9: Add secure media upload and asynchronous processing

**Files:**
- Create: `memorial-platform/modules/media/storage.ts`
- Create: `memorial-platform/modules/media/service.ts`
- Create: `memorial-platform/db/schema/media.ts`
- Create: `memorial-platform/app/api/media/sign/route.ts`
- Create: `memorial-platform/worker/jobs/process-media.ts`
- Test: `memorial-platform/tests/unit/media-policy.test.ts`
- Test: `memorial-platform/tests/integration/media.test.ts`

- [ ] **Step 1: Write failing media policy tests**

Allow JPEG, PNG, WebP, MP4, WebM and MP3 within configured limits. Reject executable content, mismatched declared MIME, unauthorized memorial access and path traversal. Assert private media never receives a public URL.

- [ ] **Step 2: Implement the storage interface**

```ts
export interface MediaStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  createReadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}
```

- [ ] **Step 3: Add upload lifecycle**

Use states `pending_upload`, `scanning`, `processing`, `ready`, `rejected`, `deleted`. The worker validates file signature, removes image EXIF data, creates image variants and marks the asset ready. Do not expose raw uploads before scanning.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/media-policy.test.ts tests/integration/media.test.ts`  
Expected: all lifecycle and authorization tests pass.

```bash
git add memorial-platform
git commit -m "feat: add secure memorial media pipeline"
```

### Task 10: Build the versioned religion, denomination and cultural-tradition catalog

**Files:**
- Create: `memorial-platform/db/schema/religion.ts`
- Create: `memorial-platform/modules/religion/catalog.ts`
- Create: `memorial-platform/modules/religion/types.ts`
- Create: `memorial-platform/db/seed/religions.ts`
- Create: `memorial-platform/db/seed/index.ts`
- Test: `memorial-platform/tests/integration/religion-catalog.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Assert that:

- religion, denomination, culture and household custom are separate entities;
- a ritual version cannot publish without at least one source;
- machine-only translations cannot reach `published`;
- uncertain compatibility returns no automatic recommendation;
- updating a published rule creates a new version.

- [ ] **Step 2: Add catalog schema**

Create `religions`, `denominations`, `cultural_traditions`, `ritual_definitions`, `ritual_versions`, `ritual_sources`, `ritual_translations`, and `ritual_compatibility_rules`. Use lifecycle states `draft`, `in_review`, `published`, `retired`.

- [ ] **Step 3: Seed neutral top-level classifications**

Seed stable slugs for secular, Christian, Muslim, Buddhist, Taoist/Chinese folk, Hindu, Jewish, Sikh, Shinto, Baháʼí, Indigenous/local, multi-tradition, custom and undisclosed. Seed classification labels only; do not seed doctrinal claims or prohibited rules without reviewed sources.

- [ ] **Step 4: Implement publish validation**

Publishing requires a source URL/citation, applicability scope, review timestamp and a human-reviewed translation for each enabled locale.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
npm test -- tests/integration/religion-catalog.test.ts
```

Expected: seed is idempotent and all governance rules pass.

```bash
git add memorial-platform
git commit -m "feat: add governed religion and culture catalog"
```

### Task 11: Implement family-controlled ritual recommendations and settings

**Files:**
- Create: `memorial-platform/modules/religion/recommendations.ts`
- Create: `memorial-platform/modules/religion/memorial-settings.ts`
- Create: `memorial-platform/db/schema/commemoration.ts`
- Test: `memorial-platform/tests/unit/ritual-compatibility.test.ts`
- Test: `memorial-platform/tests/integration/ritual-settings.test.ts`

- [ ] **Step 1: Write compatibility tests**

Cover all levels: `recommended`, `optional`, `needs_family_confirmation`, `not_recommended`, and `prohibited_combination`. Assert only `recommended` and `optional` may appear as suggestions; neither is enabled until the family explicitly saves it.

- [ ] **Step 2: Implement deterministic recommendation evaluation**

Input includes religion, denomination, cultural traditions, country, locale and household overrides. Output includes ritual version ID, compatibility, explanation translation key and source references. On conflicting rules, choose the most restrictive result.

- [ ] **Step 3: Add memorial ritual settings**

Store `enabled`, family display-name override, anonymous policy, message policy, moderation policy and the exact ritual version accepted by the family.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/ritual-compatibility.test.ts tests/integration/ritual-settings.test.ts`  
Expected: no ritual auto-enables and conflicts resolve restrictively.

```bash
git add memorial-platform
git commit -m "feat: add family-controlled ritual settings"
```

### Task 12: Implement commemorations with moderation, rate limiting and idempotency

**Files:**
- Create: `memorial-platform/modules/commemorations/service.ts`
- Create: `memorial-platform/modules/commemorations/rate-limit.ts`
- Create: `memorial-platform/app/api/memorials/[id]/commemorations/route.ts`
- Test: `memorial-platform/tests/integration/commemorations.test.ts`

- [ ] **Step 1: Write failing commemoration tests**

Verify access mode, enabled ritual version, anonymous policy, message moderation, same idempotency key returning the same record, per-IP limits, family blocking and notification failure not rolling back the commemoration.

- [ ] **Step 2: Implement `createCommemoration`**

```ts
export async function createCommemoration(
  actor: Actor,
  input: {
    memorialId: string;
    ritualVersionId: string;
    message?: string;
    locale: string;
  },
  idempotencyKey: string,
): Promise<Result<{ id: string; status: "visible" | "pending_review" }, CommemorationError>>;
```

- [ ] **Step 3: Persist and enqueue notification atomically**

Insert commemoration and outbox event in one transaction. A worker sends notifications later. Public counters count only visible, non-deleted records and are never used for ranking.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/integration/commemorations.test.ts`  
Expected: all moderation and idempotency cases pass.

```bash
git add memorial-platform
git commit -m "feat: add respectful online commemorations"
```

### Task 13: Add religious-calendar extension contracts and anniversary jobs

**Files:**
- Create: `memorial-platform/modules/religion/calendar.ts`
- Create: `memorial-platform/modules/religion/calendars/gregorian.ts`
- Create: `memorial-platform/worker/jobs/anniversary-reminders.ts`
- Test: `memorial-platform/tests/unit/calendar.test.ts`

- [ ] **Step 1: Write calendar contract tests**

Test Gregorian conversion, timezone preservation, leap-day policy and unsupported-calendar behavior. Unsupported calendars return `CALENDAR_NOT_CONFIGURED`, never a guessed date.

- [ ] **Step 2: Implement the adapter contract**

```ts
export interface ReligiousCalendarAdapter {
  id: string;
  version: string;
  toGregorian(input: CalendarDate): Result<Date, "INVALID_DATE" | "OUT_OF_RANGE">;
  nextAnniversary(input: CalendarDate, after: Date, timeZone: string):
    Result<Date, "INVALID_DATE" | "OUT_OF_RANGE">;
}
```

- [ ] **Step 3: Add reminder job**

Query enabled reminders due within the next hour, calculate using the stored adapter version and timezone, enqueue localized notification, and advance the next occurrence only after enqueue succeeds.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/calendar.test.ts`  
Expected: deterministic anniversary results and explicit unsupported errors.

```bash
git add memorial-platform
git commit -m "feat: add versioned memorial calendar adapters"
```

### Task 14: Implement privacy-aware search and duplicate detection

**Files:**
- Create: `memorial-platform/modules/search/indexer.ts`
- Create: `memorial-platform/modules/search/query.ts`
- Create: `memorial-platform/modules/search/duplicates.ts`
- Create: `memorial-platform/app/api/search/route.ts`
- Create: `memorial-platform/worker/jobs/search-index.ts`
- Test: `memorial-platform/tests/integration/search.test.ts`

- [ ] **Step 1: Write failing search tests**

Assert public memorials are found by name, alias, transliteration, year and location; unlisted and invite-only memorials are absent; switching privacy removes search visibility before asynchronous physical cleanup; duplicate candidates never auto-merge.

- [ ] **Step 2: Add search document schema and query**

Use a denormalized `search_documents` table with memorial ID, locale, searchable text, aliases, location tokens, date range, visibility and PostgreSQL `tsvector`. Enforce `visibility = 'public'` in the SQL query itself.

- [ ] **Step 3: Implement duplicate scoring**

Return component scores for normalized name, alias, date overlap and location. A high score creates `duplicate_candidates` and presents join/dispute choices; it never blocks by opaque score alone.

- [ ] **Step 4: Add anti-scraping controls**

Require bounded page sizes, cap deep pagination, rate-limit IP and authenticated account, and omit private contact or relationship-claim data from results.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/integration/search.test.ts`  
Expected: privacy and duplicate cases pass.

```bash
git add memorial-platform
git commit -m "feat: add privacy-aware memorial search"
```

### Task 15: Add reports, ownership disputes and duplicate merge audit

**Files:**
- Create: `memorial-platform/db/schema/governance.ts`
- Create: `memorial-platform/modules/governance/reports.ts`
- Create: `memorial-platform/modules/governance/disputes.ts`
- Create: `memorial-platform/modules/governance/merge.ts`
- Create: `memorial-platform/app/api/reports/route.ts`
- Test: `memorial-platform/tests/integration/governance.test.ts`

- [ ] **Step 1: Write lifecycle tests**

Test report states `open`, `triaged`, `investigating`, `resolved`, `dismissed`, `appealed`; dispute evidence isolation; reviewer restriction actions; one appeal; merge preservation of content authorship and redirect from secondary slug.

- [ ] **Step 2: Add governance schema**

Create `reports`, `ownership_disputes`, `dispute_evidence`, `duplicate_candidates`, `moderation_cases`, `moderation_actions`, and `blocked_users`. Evidence objects use a private storage prefix and never appear in general memorial queries.

- [ ] **Step 3: Implement reviewer actions**

Allow `restrict_editing`, `restrict_interactions`, `temporarily_hide`, `restore`, `merge_duplicate`, and `resolve_dispute`. Require reason, correlation ID and audit entry for every action.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/integration/governance.test.ts`  
Expected: lifecycle, evidence isolation and merge attribution pass.

```bash
git add memorial-platform
git commit -m "feat: add memorial reports and ownership disputes"
```

### Task 16: Reserve plans and entitlements without exposing payment

**Files:**
- Create: `memorial-platform/db/schema/commerce.ts`
- Create: `memorial-platform/modules/entitlements/service.ts`
- Test: `memorial-platform/tests/integration/entitlements.test.ts`
- Test: `memorial-platform/tests/e2e/no-payment.spec.ts`

- [ ] **Step 1: Write failing entitlement tests**

Assert the free plan grants one memorial, base storage, two family managers and all base rituals. Assert premium entitlements can be assigned administratively. Assert no checkout, card or purchase link appears anywhere.

- [ ] **Step 2: Add commerce reservation schema**

Create `plans`, `features`, `plan_entitlements`, `subscriptions`, `orders`, and `memorial_entitlements`. Use order states but expose no route that creates a real order.

- [ ] **Step 3: Implement entitlement resolution**

Resolve effective value by explicit memorial override, active subscription, then free-plan default. Return typed integer, boolean or string values.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- tests/integration/entitlements.test.ts
npx playwright test tests/e2e/no-payment.spec.ts
```

Expected: free benefits work and payment UI is absent.

```bash
git add memorial-platform
git commit -m "feat: reserve memorial plans and entitlements"
```

### Task 17: Add admin operations for catalog, reports and audit

**Files:**
- Create: `memorial-platform/app/[locale]/(dashboard)/admin/page.tsx`
- Create: `memorial-platform/modules/audit/service.ts`
- Create: `memorial-platform/modules/governance/admin-queries.ts`
- Test: `memorial-platform/tests/e2e/admin-access.spec.ts`

- [ ] **Step 1: Write failing admin access tests**

Verify normal users receive 404, reviewers see report and ritual-review queues, reviewers cannot change global feature flags, and super admins can publish a reviewed ritual version with a required reason.

- [ ] **Step 2: Implement server-side admin guards**

Guard the route before querying counts or sensitive data. Paginate all queues. Redact dispute evidence from list views and require a separate audited action to access it.

- [ ] **Step 3: Add append-only audit query**

Allow filter by actor, action, resource and date. Never add update or delete operations for audit rows through the application.

- [ ] **Step 4: Verify and commit**

Run: `npx playwright test tests/e2e/admin-access.spec.ts`  
Expected: role separation and evidence redaction pass.

```bash
git add memorial-platform
git commit -m "feat: add governed memorial administration"
```

### Task 18: Add robots, sitemap, structured data and deletion behavior

**Files:**
- Create: `memorial-platform/app/robots.ts`
- Create: `memorial-platform/app/sitemap.ts`
- Create: `memorial-platform/modules/memorials/seo.ts`
- Create: `memorial-platform/modules/memorials/export.ts`
- Create: `memorial-platform/app/api/memorials/[id]/export/route.ts`
- Test: `memorial-platform/tests/integration/seo.test.ts`

- [ ] **Step 1: Write failing SEO tests**

Assert only public/indexable memorials enter sitemap; unlisted and invite-only pages emit `noindex`; JSON-LD contains no private contact data; deleted memorials return `410` during cleanup and disappear after final purge.

Also assert only owners and administrators can request an export; the archive contains biography, timeline, tributes, family-approved commemorations, translation metadata and a media manifest, but excludes login credentials, private dispute evidence, blocked-user details and internal risk scores.

- [ ] **Step 2: Implement privacy-derived metadata**

Derive canonical, alternate locales, robots and structured data from memorial privacy and content locale. Never trust a client-supplied indexability flag.

- [ ] **Step 3: Implement deletion workflow**

Owner deletion sets `deletion_requested_at` and `purge_after`, removes logical search visibility immediately, and emits cleanup jobs. The worker deletes derivatives, originals and search documents after the recovery period, then pseudonymizes non-required references.

- [ ] **Step 4: Implement asynchronous export**

Authorize the requester, create an `export.requested` outbox event and return `202`. The worker builds a versioned JSON manifest plus authorized media files in a private archive, stores an expiry time and sends a short-lived signed download URL. Retrying with the same idempotency key returns the existing export job.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/integration/seo.test.ts`  
Expected: sitemap, noindex and deletion states pass.

```bash
git add memorial-platform
git commit -m "feat: enforce memorial SEO privacy and deletion"
```

### Task 19: Add observability, worker retries and operational health

**Files:**
- Create: `memorial-platform/lib/observability.ts`
- Create: `memorial-platform/worker/index.ts`
- Create: `memorial-platform/worker/runner.ts`
- Create: `memorial-platform/app/api/health/live/route.ts`
- Create: `memorial-platform/app/api/health/ready/route.ts`
- Test: `memorial-platform/tests/unit/worker-retry.test.ts`
- Test: `memorial-platform/tests/integration/health.test.ts`

- [ ] **Step 1: Write retry tests**

Assert exponential backoff, maximum attempts, dead-letter recording, idempotent reprocessing and redaction of OTPs, session tokens and dispute evidence from logs.

- [ ] **Step 2: Implement structured telemetry**

Include correlation ID, job ID, topic, duration and result code. Do not log message bodies, credentials, private evidence or raw provider responses.

- [ ] **Step 3: Implement health endpoints**

Liveness confirms the process event loop. Readiness performs bounded database and Redis checks. Neither endpoint exposes connection strings or stack traces.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/unit/worker-retry.test.ts tests/integration/health.test.ts`  
Expected: retry and dependency-health cases pass.

```bash
git add memorial-platform
git commit -m "feat: add memorial operations and worker resilience"
```

### Task 20: Complete launch-path E2E, accessibility and recovery validation

**Files:**
- Create: `memorial-platform/tests/e2e/memorial-journey.spec.ts`
- Create: `memorial-platform/tests/e2e/accessibility.spec.ts`
- Create: `memorial-platform/scripts/verify-backup-restore.ts`
- Create: `memorial-platform/docs/runbook.md`
- Modify: `memorial-platform/package.json`

- [ ] **Step 1: Write the complete journey**

The E2E test must:

1. sign in by email;
2. create a memorial as a spouse;
3. detect no blocking duplicate;
4. select secular plus a family custom;
5. explicitly enable “Share a memory”;
6. publish publicly;
7. find it in search;
8. create an idempotent commemoration;
9. invite an editor;
10. switch to invite-only;
11. verify anonymous access and search fail;
12. verify the invited editor can access but cannot change privacy.

- [ ] **Step 2: Add accessibility assertions**

Run automated WCAG checks for sign-in, creation, public memorial, invite-only denial and admin queue in English, Spanish, simplified Chinese and Arabic RTL. Add explicit keyboard focus and accessible-name assertions for the ritual selector.

- [ ] **Step 3: Add backup/restore verification**

The script creates a uniquely named fixture, invokes the documented PostgreSQL backup command in the test environment, restores into an empty verification database, and asserts the memorial, membership, ritual setting, audit event and outbox event exist.

- [ ] **Step 4: Write the operations runbook**

Document exact commands for migration, rollback by forward migration, worker start, health checks, database backup/restore, search reindex, privacy incident containment, leaked media revocation, disabling phone auth and disabling a ritual version.

- [ ] **Step 5: Run the release gate**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run db:migrate
npm run db:seed
npx tsx scripts/verify-backup-restore.ts
```

Expected: every command exits 0; E2E confirms privacy, language, ritual and permission behavior; backup restoration reports `RESTORE_VERIFIED`.

- [ ] **Step 6: Commit**

```bash
git add memorial-platform
git commit -m "test: validate memorial platform launch path"
```

## 5. Milestone release gates

### Gate A: Foundation

Tasks 1–5 complete. Build, unit tests and hidden-phone E2E pass. English, Spanish and simplified Chinese catalogs have equal keys; Arabic renders RTL.

### Gate B: Memorial core

Tasks 6–9 complete. Family creation, permissions, privacy, content versions and secure media are independently usable.

### Gate C: Religion and commemoration

Tasks 10–13 complete. No ritual auto-enables, all published rules have reviewed sources, and family choices control visitor actions.

### Gate D: Discovery and governance

Tasks 14–18 complete. Search cannot expose private memorials, duplicate records do not auto-merge, disputes are audited, payment is absent and SEO respects privacy.

### Gate E: Launch candidate

Tasks 19–20 complete. Operations, retries, health, accessibility, end-to-end journeys and backup restoration pass.

## 6. Final verification checklist

- [ ] `git status --short` contains no unintended files.
- [ ] Every migration applies to an empty database.
- [ ] Every migration also applies to a database from the previous milestone.
- [ ] All server routes validate input with Zod.
- [ ] All protected reads and writes call central permission functions.
- [ ] Invite-only resources return 404 to unauthorized users.
- [ ] Private media never has a permanent public URL.
- [ ] Phone authentication routes pass tests while the UI remains hidden.
- [ ] No ritual is enabled solely because a religion was selected.
- [ ] Every published ritual version has sources and human-reviewed translations.
- [ ] Search SQL itself filters non-public records.
- [ ] Privacy changes revoke access synchronously.
- [ ] Commemorations and creation routes are idempotent.
- [ ] Payment and checkout routes do not exist.
- [ ] English, Spanish and simplified Chinese launch journeys pass.
- [ ] Arabic RTL has no horizontal overflow.
- [ ] WCAG 2.2 AA automated checks pass on critical routes.
- [ ] Backup restoration succeeds and is recorded in the release evidence.

## 7. Recommended execution order

Execute tasks strictly in numerical order. Use a dedicated `codex/global-memorial-platform` branch or isolated worktree. Do not begin a later milestone while the current milestone gate is failing. After each task, run the scoped tests shown in that task and commit only the listed files.
