# DateCN Free Vercel Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision an isolated zero-cost test stack and publish DateCN to a verified Vercel temporary URL.

**Architecture:** Use one independent Vercel Hobby project named `datecn-free-test`, one Neon Free PostgreSQL database, one Upstash Free Redis database, and one private Vercel Blob store. Secrets live only in Vercel environment variables and a gitignored local pull file used for migration.

**Tech Stack:** npm/package-lock, Vercel CLI/dashboard, Neon PostgreSQL, Upstash Redis, Vercel Blob, Drizzle Kit, Playwright browser verification.

All repository commands in this plan run from the `dating-platform` directory with npm. Do not use pnpm or corepack and do not change `package-lock.json`. When the Vercel CLI is needed, use the reviewed one-off form `npm exec --yes --package=vercel@latest -- vercel ...`; npm places that CLI in its cache rather than adding it to this project. The command form is based on [npm exec](https://docs.npmjs.com/cli/npm-exec/) and the [Vercel CLI reference](https://vercel.com/docs/cli/). Recheck `npm exec --help` and the relevant Vercel command's official help before a future state-changing run.

---

### Task 1: Verify the free-only gate and link the project

**Files:**
- Create locally but never commit: `.vercel/project.json`
- Create locally but never commit: `.env.vercel.local`

- [ ] **Step 1: Confirm the Hobby quota window has cleared**

Open Vercel Team → Usage and require `Fluid Active CPU` to be below `4h / 4h`. If it has not cleared, stop without creating resources.

- [ ] **Step 2: Authenticate and link an isolated project**

Run: `npm exec --yes --package=vercel@latest -- vercel login`

Expected: browser authentication succeeds and the authenticated operator can access the real team scope `lilianfu701-pixels-projects`. Do not substitute a similarly named personal account.

Run: `npm exec --yes --package=vercel@latest -- vercel link --yes --project datecn-free-test --scope lilianfu701-pixels-projects`

Expected: `.vercel/project.json` names only `datecn-free-test`, and the Vercel dashboard shows it under `lilianfu701-pixels-projects`.

- [ ] **Step 3: Verify no billing method is requested**

Open the project Overview and Settings. Confirm plan is `Hobby`, no Pro trial is active, and no payment method or spend-on-demand setting was added.

### Task 2: Provision and connect the free data services

**Files:**
- Vercel project environment only; no committed secrets.

- [ ] **Step 1: Create Neon Free PostgreSQL**

From Project → Storage, install Neon, choose the explicitly labeled Free plan, name the resource `datecn-free-test-db`, select AWS US East (N. Virginia) to match Vercel `iad1`, and connect Production, Preview, and Development environments. Stop if the final button mentions a charge, card, trial conversion, or pay-as-you-go.

- [ ] **Step 2: Normalize the pooled connection variable**

Verify the integration created a pooled TLS PostgreSQL URL. Map that value to `DATABASE_URL` without printing it. Require a `postgresql://` URL with secure `sslmode`; allow only optional `channel_binding=require`, reject every other URL query parameter, and keep all ambient `PG*` connection/session overrides absent.

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

After project creation/linking, open the Vercel project Overview and Settings → Domains. Copy the exact Vercel-provided HTTPS project hostname that the dashboard displays and record it as `<VERCEL_TEMP_ORIGIN>`. It must be a single origin with no path, credentials, query, or fragment. If Vercel does not display an assigned hostname, stop and resolve that in the dashboard; never derive or guess one from `datecn-free-test`.

Set the following for Production and Preview, replacing the placeholder with that exact displayed origin:

```dotenv
APP_URL=<VERCEL_TEMP_ORIGIN>
BETTER_AUTH_URL=<VERCEL_TEMP_ORIGIN>
FREE_TEST_MODE=1
PROFILE_MEDIA_MAX_BYTES=10485760
PROFILE_MEDIA_UPLOAD_EXPIRY_SECONDS=300
PROFILE_MEDIA_MAX_PHOTOS=6
```

Do not set `STRIPE_SECRET_KEY`, payment webhooks, real email/SMS webhooks, identity providers, `E2E_MODE`, or `REALTIME_PUBLIC_URL`.

- [ ] **Step 3: Pull a gitignored migration environment**

Run: `npm exec --yes --package=vercel@latest -- vercel env pull .env.vercel.local --environment=production --scope lilianfu701-pixels-projects`

Expected: the file is ignored by git and contains the required server variables. Confirm with variable names only; never display values.

### Task 4: Migrate the empty database and create synthetic users

**Files:**
- Use: `scripts/run-free-test-migration.mjs`
- Verify: `tests/unit/operations/free-test-migration.test.ts`
- Create: `scripts/seed-free-test.ts`
- Create: `tests/unit/operations/seed-free-test.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing seed safety tests**

Require `FREE_TEST_MODE=1`, `FREE_TEST_SEED_CONFIRM=datecn-free-test`, HTTPS `APP_URL`, exact independently supplied Neon hostname/database arguments, and email suffix `@datecn.test`. Verify refusal before credential or database access when any condition is absent or the target differs. Verify idempotent creation of two verified synthetic users, profiles, match, active conversation, and initial messages.

- [x] **Step 2: Implement the bounded seed script**

Use deterministic synthetic addresses `alice@datecn.test` and `liam@datecn.test`, random passwords written once (never printed) to a local gitignored `.artifacts/free-test-credentials.json`, and one advisory-locked transaction for profile/match/conversation rows. Never weaken application authentication rules and never enable E2E routes.

- [x] **Step 3: Run tests and commit the seed tool**

Run: `npm exec -- vitest run tests/unit/operations/seed-free-test.test.ts`

Expected: PASS.

Commit: `git commit -m "test: add guarded free deployment seed"`.

- [ ] **Step 4: Run all migrations against the isolated database**

Use the tested script and the shell-specific commands in [Database target preflight and migration](../../runbooks/free-test-deployment.md#database-target-preflight-and-migration). It loads `.env.vercel.local` only into that Node process, prints only a successfully confirmed host/database pair, and accepts only a TLS-required `postgresql:` URL on a strict `.neon.tech` subdomain. Run `--check` first; it cannot spawn. After independent dashboard comparison, change only the mode to exact `--confirm=datecn-free-test`; the script then uses `spawnSync` with `npm.cmd` on Windows or `npm` elsewhere, argument array `run`, `db:migrate`, inherited stdio, and `shell: false`. Never source the file into the shell or print the connection URL.

Run before any real migration: `npm exec -- vitest run tests/unit/operations/free-test-migration.test.ts`

Expected: migrations `0000` through `0040` apply successfully once and a second run is a no-op.

- [ ] **Step 5: Seed synthetic test data**

Keep the independently dashboard-confirmed hostname/database variables from the migration preflight. Set `FREE_TEST_SEED_CONFIRM=datecn-free-test` only for the seed process and use the PowerShell or POSIX command in [Synthetic seed target confirmation](../../runbooks/free-test-deployment.md#synthetic-seed-target-confirmation). The npm command requires both `--expected-host` and `--expected-database`; it fails before credential I/O or database construction if either differs from `DATABASE_URL`.

Expected: two synthetic users and one conversation are created; rerunning reports existing records without duplication.

### Task 5: Deploy and verify the temporary Vercel URL

**Files:**
- Create: `docs/deployment/free-test-release-2026-08-24.md`

- [ ] **Step 1: Run the local release gate**

Run: `npm test`

Run after a recorded concurrent PGlite timeout: `npm test -- --maxWorkers=1 --no-file-parallelism`

Run: `npm exec -- tsc --noEmit`

Run: `npm run lint`

Run: `npm run build`

Run: `npm exec -- drizzle-kit check`

Expected: every command exits 0.

- [ ] **Step 2: Deploy production to the temporary URL**

Run: `npm exec --yes --package=vercel@latest -- vercel deploy --prod --yes --skip-domain --scope lilianfu701-pixels-projects`

Expected: Vercel prints the exact deployment URL on stdout and reports Ready. Record that value; do not predict a hostname pattern. Confirm the dashboard-displayed `<VERCEL_TEMP_ORIGIN>` now points to this verified deployment before smoke testing. `--skip-domain` prevents an existing custom production domain from being assigned during this temporary-URL stage.

- [ ] **Step 3: Run browser smoke tests**

Verify Chinese and English home pages, registration using a `@datecn.test` mailbox, login, onboarding, profile upload, discover, match, membership test state, and two-account messages at desktop and 390-pixel mobile widths. Require no console errors, no failed same-origin API requests, and message appearance within five seconds.

- [ ] **Step 4: Record the deployment without secrets**

Document project/resource names, temporary URL, region, plan labels, migration version, test-account emails, quota snapshot, verification results, and rollback entry points. Do not include passwords, tokens, connection URLs, or API keys.

- [ ] **Step 5: Commit the deployment record**

```text
git add docs/deployment/free-test-release-2026-08-24.md
git commit -m "docs: record DateCN free test deployment"
```
