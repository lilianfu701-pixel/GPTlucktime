# DateCN Free Vercel Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision an isolated zero-cost test stack and publish DateCN to a verified Vercel temporary URL.

**Architecture:** Use one independent Vercel Hobby project named `datecn-free-test`, one Neon Free PostgreSQL database, one Upstash Free Redis database, and one private Vercel Blob store. Secrets live only in Vercel environment variables and a gitignored local pull file used for migration.

**Tech Stack:** Vercel CLI/dashboard, Neon PostgreSQL, Upstash Redis, Vercel Blob, Drizzle Kit, Playwright browser verification.

---

### Task 1: Verify the free-only gate and link the project

**Files:**
- Create locally but never commit: `.vercel/project.json`
- Create locally but never commit: `.env.vercel.local`

- [ ] **Step 1: Confirm the Hobby quota window has cleared**

Open Vercel Team → Usage and require `Fluid Active CPU` to be below `4h / 4h`. If it has not cleared, stop without creating resources.

- [ ] **Step 2: Authenticate and link an isolated project**

Run: `corepack pnpm dlx vercel@latest login`  
Expected: browser authentication succeeds for `lilianfu701-pixel`.  
Run: `corepack pnpm dlx vercel@latest link --yes --project datecn-free-test --scope lilianfu701-pixels-projects`  
Expected: `.vercel/project.json` names only `datecn-free-test`.

- [ ] **Step 3: Verify no billing method is requested**

Open the project Overview and Settings. Confirm plan is `Hobby`, no Pro trial is active, and no payment method or spend-on-demand setting was added.

### Task 2: Provision and connect the free data services

**Files:**
- Vercel project environment only; no committed secrets.

- [ ] **Step 1: Create Neon Free PostgreSQL**

From Project → Storage, install Neon, choose the explicitly labeled Free plan, name the resource `datecn-free-test-db`, select AWS US East (N. Virginia) to match Vercel `iad1`, and connect Production, Preview, and Development environments. Stop if the final button mentions a charge, card, trial conversion, or pay-as-you-go.

- [ ] **Step 2: Normalize the pooled connection variable**

Verify the integration created a pooled TLS PostgreSQL URL. Map that value to `DATABASE_URL` without printing it. Require a `postgresql://` URL with `sslmode=require` or provider-enforced TLS.

- [ ] **Step 3: Create Upstash Free Redis**

Install Upstash Redis, choose the explicit Free plan, name it `datecn-free-test-cache`, select AWS US East, and link all environments. Require the integration to provide `REDIS_URL` with `rediss://`; stop if only a paid plan is offered.

- [ ] **Step 4: Create a private Vercel Blob store**

Create a private Blob store named `datecn-free-test-media`, connect all environments, and verify Vercel injects `BLOB_READ_WRITE_TOKEN`. Stop if the operation asks for a payment method.

### Task 3: Install server-only environment values

**Files:**
- Vercel project environment only.

- [ ] **Step 1: Generate independent secrets locally**

Generate random values with Node `crypto.randomBytes`: 48-byte base64url for `BETTER_AUTH_SECRET`, `PROFILE_MEDIA_TOKEN_SECRET`, `FREE_TEST_ACCESS_SECRET`, and worker secrets; 32-byte base64url for encryption keys. Do not print values to the terminal transcript.

- [ ] **Step 2: Add non-secret test settings**

Set these exact values for Production and Preview:

```dotenv
APP_URL=https://datecn-free-test.vercel.app
BETTER_AUTH_URL=https://datecn-free-test.vercel.app
FREE_TEST_MODE=1
PROFILE_MEDIA_MAX_BYTES=10485760
PROFILE_MEDIA_UPLOAD_EXPIRY_SECONDS=300
PROFILE_MEDIA_MAX_PHOTOS=6
```

Do not set `STRIPE_SECRET_KEY`, payment webhooks, real email/SMS webhooks, identity providers, `E2E_MODE`, or `REALTIME_PUBLIC_URL`.

- [ ] **Step 3: Pull a gitignored migration environment**

Run: `corepack pnpm dlx vercel@latest env pull .env.vercel.local --environment production`  
Expected: the file is ignored by git and contains the required server variables. Confirm with variable names only; never display values.

### Task 4: Migrate the empty database and create synthetic users

**Files:**
- Create: `scripts/seed-free-test.ts`
- Create: `tests/unit/operations/seed-free-test.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing seed safety tests**

Require `FREE_TEST_MODE=1`, `FREE_TEST_SEED_CONFIRM=datecn-free-test`, HTTPS `APP_URL`, and email suffix `@datecn.test`. Verify refusal when any condition is absent and verify idempotent creation of two verified synthetic users, profiles, match, active conversation, and initial messages.

- [ ] **Step 2: Implement the bounded seed script**

Use deterministic synthetic addresses `alice@datecn.test` and `liam@datecn.test`, random passwords printed once to a local gitignored `.artifacts/free-test-credentials.json`, and transactions for profile/match/conversation rows. Never weaken application authentication rules and never enable E2E routes.

- [ ] **Step 3: Run tests and commit the seed tool**

Run: `corepack pnpm vitest run tests/unit/operations/seed-free-test.test.ts`  
Expected: PASS.  
Commit: `git commit -m "test: add guarded free deployment seed"`.

- [ ] **Step 4: Run all migrations against the isolated database**

Load `.env.vercel.local` only for this process and run: `corepack pnpm db:migrate`  
Expected: migrations `0000` through `0040` apply successfully once and a second run is a no-op.

- [ ] **Step 5: Seed synthetic test data**

Set `FREE_TEST_SEED_CONFIRM=datecn-free-test` only for the process and run: `corepack pnpm seed:free-test`  
Expected: two synthetic users and one conversation are created; rerunning reports existing records without duplication.

### Task 5: Deploy and verify the temporary Vercel URL

**Files:**
- Create: `docs/deployment/free-test-release-2026-08-24.md`

- [ ] **Step 1: Run the local release gate**

Run: `corepack pnpm test`  
Run: `corepack pnpm exec tsc --noEmit`  
Run: `corepack pnpm lint`  
Run: `corepack pnpm build`  
Expected: every command exits 0.

- [ ] **Step 2: Deploy production to the temporary URL**

Run: `corepack pnpm dlx vercel@latest deploy --prod --yes`  
Expected: a successful `https://datecn-free-test-*.vercel.app` production deployment.

- [ ] **Step 3: Run browser smoke tests**

Verify Chinese and English home pages, registration using a `@datecn.test` mailbox, login, onboarding, profile upload, discover, match, membership test state, and two-account messages at desktop and 390-pixel mobile widths. Require no console errors, no failed same-origin API requests, and message appearance within five seconds.

- [ ] **Step 4: Record the deployment without secrets**

Document project/resource names, temporary URL, region, plan labels, migration version, test-account emails, quota snapshot, verification results, and rollback entry points. Do not include passwords, tokens, connection URLs, or API keys.

- [ ] **Step 5: Commit the deployment record**

```text
git add docs/deployment/free-test-release-2026-08-24.md
git commit -m "docs: record DateCN free test deployment"
```
