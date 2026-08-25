# Free public test deployment runbook

## Current status

DateCN has not been deployed by this runbook. No Vercel project, Neon database, Upstash Redis database, or Blob store has been created, and no payment method has been added. `datecn.org` and `www.datecn.org` still use their existing Cloudflare-proxied A records at `178.128.54.40`. Do not change DNS during this runbook; custom-domain work starts only after the temporary URL passes and follows [the domain cutover plan](../superpowers/plans/2026-08-24-datecn-domain-cutover.md).

The latest recorded Vercel Hobby check, at approximately 2026-08-25 01:45 PT, showed Fluid Active CPU at `4h26m / 4h`. This exceeds the free allowance and blocks provisioning or deployment. Recheck the dashboard and its reset window before every attempt. An unchanged or ambiguous quota is a stop condition, not permission to continue.

## What this test environment is

- Vercel Hobby runs the Next.js website and HTTP API.
- Neon Free is the PostgreSQL source of truth. Upstash Free supplies Redis for rate limits and the synthetic mailbox.
- A private Vercel Blob store holds synthetic profile images. Browser clients receive only bounded upload credentials; the Blob token stays server-side.
- Messaging polls only the active conversation, approximately every two seconds after the previous recovery completes. Polling pauses while the page is hidden and catches up immediately when visible again. Recovered incoming messages enqueue a delivered receipt; incoming messages in the selected, visible conversation enqueue read receipts. Receipt delivery uses the same-origin HTTP endpoint and its bounded retry queue.
- The synthetic mailbox accepts only canonical `@datecn.test` recipients. It stores one encrypted newest item in Redis for at most 15 minutes, consumes it once with `GETDEL`, requires the server-held access code, and never sends external email or SMS.
- A localized global banner must identify every page as a test environment and state that data is synthetic and real payment/email/SMS are disabled.

This environment is not production. It has no SLA, paid capacity, real billing, real notification delivery, real identity verification, or permission to accept real users or personal data.

## Hard stops

Stop without creating or changing anything if a provider asks for a card, payment, pay-as-you-go approval, auto-renewing trial, or paid upgrade. Also stop if a free quota is exhausted or unclear, TLS is unavailable, a server credential would reach the browser, a real external-service variable is present, or the target resource cannot be proven isolated.

Never use real users, real PII, real email addresses or phone numbers, identity documents, payment details, production images, production database exports, or existing customer data. Never weaken authentication, expose an `E2E_*` route, enable `REALTIME_PUBLIC_URL`, or replace the guarded seed with manual SQL.

## Environment variable inventory

Record names and whether they are present; never print or paste values into logs, tickets, screenshots, or this repository.

Required application and data names:

- `DATABASE_URL`
- `REDIS_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `APP_URL`
- `FREE_TEST_MODE`
- `FREE_TEST_ACCESS_SECRET`

Required private Blob profile-media names:

- `BLOB_READ_WRITE_TOKEN`
- `PROFILE_MEDIA_TOKEN_SECRET`
- `PROFILE_MEDIA_MAX_BYTES`
- `PROFILE_MEDIA_UPLOAD_EXPIRY_SECONDS`
- `PROFILE_MEDIA_MAX_PHOTOS`

Optional server-only operational names, only when the corresponding reviewed route is scheduled:

- `AUTH_TRUSTED_PROXY_TOKEN`
- `ADMIN_WORKER_CRON_SECRET`
- `PRIVACY_WORKER_CRON_SECRET`
- `NOTIFICATION_WORKER_CRON_SECRET`
- `MEDIA_WORKER_CRON_SECRET`

The following groups must remain absent in free-test mode: `STRIPE_*`, `EMAIL_*`, `SMS_*`, `IDENTITY_*`, `E2E_*`, `REALTIME_PUBLIC_URL`, and every `PROFILE_MEDIA_STORAGE_*` S3 name. Blob and S3 are mutually exclusive; configure exactly one profile-media backend, never both. Do not create any `NEXT_PUBLIC_*` copy of a secret or server-only mode flag.

## Generate and store secrets

1. Generate each secret independently with a cryptographically secure random generator. Use at least 48 random bytes for authentication, free-test access, media-token, and worker secrets; use the exact format required by a key-ring or encryption variable when one is later enabled.
2. Write values directly to an approved password manager and the isolated Vercel project's encrypted environment settings. Do not display them in terminal output or shell history.
3. If a local migration environment is needed, pull it into the gitignored `.env.vercel.local`, restrict access to the operator, and delete or rotate it after use. Confirm only variable names, never values.
4. Use separate values per purpose and environment. On suspected exposure, close public access, rotate the affected values, redeploy, and invalidate the old values before reopening.

## Provision only after the quota gate clears

1. In Vercel Usage, record owner, PT/UTC timestamp, Fluid Active CPU reading, reset window, screenshot/link, and result. Continue only below the Hobby limit.
2. Link a new isolated Hobby project named `datecn-free-test`. Confirm no card, Pro trial, spend-on-demand, or automatic overage was enabled.
3. Create the explicitly labeled free resources: Neon `datecn-free-test-db`, Upstash `datecn-free-test-cache`, and private Blob `datecn-free-test-media`. Prefer the deployment region specified by the provisioning plan. Stop if the final action mentions a charge.
4. Confirm the database URL is pooled PostgreSQL with provider-enforced TLS, Redis uses TLS, Blob is private, and resources are connected only to the intended project environments.
5. Capture dashboard limits and current usage for Vercel CPU, Neon compute/storage, Upstash commands/storage/bandwidth, and Blob storage/transfer/operations. Use the provider's displayed values; do not rely on remembered quotas.

## Configure, verify, migrate, and seed

1. Add the required environment names to Production and Preview. `APP_URL` and `BETTER_AUTH_URL` must be the exact HTTPS temporary deployment origin, and `FREE_TEST_MODE` must be paired with its access secret. Keep every forbidden external-service group absent.
2. Run the local release gate from the app directory with npm: the full test suite in a reliable single-worker mode when PGlite concurrency times out, TypeScript, full lint, a production build under safe free-test variables, and `drizzle-kit check`. Attach counts, skips, durations, and exit codes.
3. Load the isolated migration environment for one process and run `npm run db:migrate`. Verify migrations `0000` through `0040` apply once, then rerun and require a no-op result. Stop on any unexpected pre-existing table or data.
4. The guarded seed command is not yet present in this repository; it is created and tested in Task 4 of [the provisioning plan](../superpowers/plans/2026-08-24-free-vercel-provisioning.md). Do not deploy until that reviewed command and its safety test exist. Then run only `npm run seed:free-test` with `FREE_TEST_SEED_CONFIRM` set for that one process, using only `alice@datecn.test` and `liam@datecn.test`. Require two verified synthetic users, profiles, one match, one active conversation, initial messages, and an idempotent second run.

## Deploy and smoke the temporary URL

1. Deploy the verified immutable commit to the Vercel temporary URL. Record the exact URL returned by Vercel; do not guess it from the project name.
2. Before sharing access, open `/zh` and `/en` and confirm the localized global test banner is visible. If any page omits it, disable public access and fail the gate.
3. At desktop and 390-pixel widths, test registration with an `@datecn.test` address, mailbox retrieval with the private access code, verification, login, onboarding, member center, discovery/match, membership test state, and profile upload/replace/delete using synthetic images only.
4. With both synthetic accounts, open the same conversation. Confirm messages appear within five seconds while visible, polling pauses while hidden, catch-up occurs after returning, and delivered/read receipts advance at the expected points.
5. Confirm there are no browser console errors, failed same-origin API requests, external payment/notification/identity calls, horizontal overflow at 390 pixels, or leaked credentials. Attach evidence and quota readings after the smoke.

Do not add `datecn.org` or change Cloudflare records during temporary-URL smoke. After every gate passes, prepare the exact old/new DNS table using Vercel's project-specific domain inspection, then wait for explicit user confirmation as required by the domain cutover plan. Never insert generic Vercel DNS examples.

## Disable, recover, and roll back

For a quota warning, security concern, external-service attempt, missing banner, failed migration, or failed critical smoke:

1. Stop sharing the access code and disable public access or the deployment first.
2. Preserve deployment, migration, provider-usage, and smoke evidence without secrets. Do not delete data while diagnosing.
3. If configuration is the cause, remove `FREE_TEST_MODE` together with `FREE_TEST_ACCESS_SECRET` only after access is closed; keep the pair consistent so environment validation fails closed. Rotate any exposed secret and redeploy the last verified commit.
4. If application behavior regressed, restore the previous verified Vercel deployment. Apply only backward-compatible migrations; never reverse a destructive migration or overwrite the database to force rollback.
5. If a free data service is exhausted or unavailable, keep the site closed until it recovers or a separately approved free replacement is verified. Never silently switch to a paid tier.
6. If DNS was later cut over under the separate plan, restore both saved records to `178.128.54.40` with their original Cloudflare proxy states and TTLs, then verify the pre-cutover response. Otherwise leave DNS untouched.

Recovery is complete only after the temporary URL passes the full smoke again, post-recovery quota readings are attached, secrets are confirmed private, and the release owner records an explicit PASS. Production release still requires the separate production checklist.
