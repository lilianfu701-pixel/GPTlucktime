# Release checklist

Every item needs an owner, timestamp, evidence link, and explicit result. A missing external dependency is a failed gate, not a waiver or skip.

## Free public test release gate

This gate is only for the isolated, no-cost public test. It does not satisfy, replace, or weaken the production checklist below. Stop immediately if any provider requests a card, charge, paid plan, auto-renewing trial, or spend-on-demand approval.

Release record: owner `_____`; UTC/PT timestamp `_____`; candidate commit `_____`; temporary Vercel URL `_____`; evidence folder/link `_____`; final result `PASS / FAIL`.

### Scope, cost, and safety

- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Confirm the Vercel project is isolated and labeled Hobby, Neon is Free, Upstash is Free, Blob is private and within its free allowance, no card is attached, and no paid trial or automatic overage is enabled.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Confirm only synthetic accounts, `@datecn.test` addresses, test images, and test messages are allowed. Do not admit real users or enter real PII, payment data, email addresses, phone numbers, identity documents, or sensitive photos.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Confirm Stripe, real email, SMS, and identity-provider variables are absent; `E2E_MODE`, `REALTIME_PUBLIC_URL`, and every public copy of a server secret are absent; no external delivery or charge can occur.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Confirm `FREE_TEST_MODE` and its access secret are set only server-side, both application origins use HTTPS, the localized global test banner appears on every tested page, and the access code is shared only through an approved private channel.

### Quotas, data, and temporary URL

- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Capture current provider-dashboard readings and reset windows for Vercel Fluid Active CPU, Neon compute/storage, Upstash commands/storage/bandwidth, and Blob storage/transfer/operations. Stop when any allowance is exhausted or its free status is ambiguous.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Verify the exact-one media rule: private `BLOB_READ_WRITE_TOKEN` plus `PROFILE_MEDIA_TOKEN_SECRET` is active, and every `PROFILE_MEDIA_STORAGE_*` S3 variable is absent.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Apply migrations `0000` through `0040` to the new isolated Neon database; attach the first-run result and a second no-op result. Never migrate an existing or production database for this test.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Use only the reviewed guarded synthetic seed command after its safety test passes; require the explicit deployment confirmation value and verify an idempotent rerun. Do not substitute hand-written SQL or import existing users.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Deploy and validate the Vercel temporary URL before adding or changing any custom domain. Record the exact deployment URL and immutable commit; do not infer a URL from a project name.

### Public-test smoke and rollback

- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — At desktop and 390-pixel widths, smoke `/zh` and `/en`, registration through the synthetic mailbox, login, onboarding, member center, discovery/match, profile upload/replace/delete, membership test state, and two-account messaging. Require no console errors, no failed same-origin API calls, and message appearance within five seconds.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Verify the mailbox rejects non-`@datecn.test` recipients and wrong access codes, returns only the newest unexpired item once, and never exposes notification URLs in logs. Verify the global banner states test data and no real payment/email/SMS.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Exercise disable/recovery: remove public access, disable the deployment or set `FREE_TEST_MODE` off only after access is closed, preserve evidence, and prove the prior deployment can be restored without reusing compromised secrets.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Record rollback owners and exact resource shutdown steps. A failed migration, quota warning, missing banner, external-service attempt, security error, or failed critical smoke is a release failure.
- [ ] Owner `_____`; timestamp `_____`; evidence `_____`; result `_____` — Keep `datecn.org` and `www.datecn.org` unchanged until the temporary URL passes. Before any DNS edit, obtain explicit user confirmation on the final old/new record table from the domain-cutover plan; use only Vercel's project-specific values and preserve the recorded rollback values.

## Production release checklist

The following gates apply to a real production release. Free-test evidence cannot be used as a waiver.

### Before release

- [ ] Validate the complete production environment as one atomic configuration; confirm no test, placeholder, local adapter, or `E2E_*` variable is enabled.
- [ ] Run schema validation, migration checks, and a migration rehearsal against a disposable production-like database. Confirm backward compatibility with the rollback artifact.
- [ ] Run the full serial unit/integration suite, deterministic local Playwright acceptance, TypeScript, lint, production build, and `drizzle-kit check`.
- [ ] Run external acceptance preflight and the real PostgreSQL backup/restore verification. Attach row counts, FK result, recent message, subscription/entitlement, audit result, and measured RPO/RTO.
- [ ] Verify encryption, auth, ingress, webhook, worker, storage, and realtime key-rotation readiness, including documented previous-key overlap and emergency revocation owners.
- [ ] Verify the Stripe endpoint uses HTTPS, the correct live-mode account and signing secret, idempotent processing, alerting, and a successful signed smoke event. Local fixture results do not satisfy this item.
- [ ] Verify admin accounts require MFA, recent-MFA checks work, roles are least privilege, break-glass access is tested, and two-person approvals are staffed.
- [ ] Confirm email/SMS, identity, media-review, Redis, object-storage, realtime, billing, privacy, notification, media, and admin workers have health checks and owned alerts.
- [ ] Review export, deletion, retention, and legal-hold behavior with Privacy/Legal; verify paused/deferred workflows retain durable state.
- [ ] Name the incident commander, release operator, rollback operator, database owner, Finance owner, and Trust & Safety owner.

### Release and smoke

- [ ] Record the release artifact, commit, migration version, configuration version, and rollout start.
- [ ] Apply migrations before code only when the documented compatibility order permits it.
- [ ] Smoke sign-in/registration, verification, profile/photo review, discovery/match, messaging/reconnect/block, checkout/webhook/entitlement/cancel/refund, report/restriction/appeal, admin MFA/permissions, and privacy export/deletion.
- [ ] Confirm dashboards and alerts for errors, latency, saturation, queue age, webhook failures, reconciliation discrepancies, moderation backlog, and privacy deadlines.
- [ ] Obtain monitoring signoff from service, Finance, Trust & Safety, Security, and Privacy owners.

### Rollback

- [ ] Define objective rollback thresholds and the decision owner before rollout.
- [ ] Confirm the previous artifact is deployable and migrations do not require unsafe reversal.
- [ ] On rollback, pause incompatible workers, preserve ledger/audit/evidence, deploy the previous artifact, validate critical smoke paths, and reconcile queued/provider events.
- [ ] If data recovery is required, stop affected writes and follow the incident runbook; restore only to an explicitly approved target after disposable restore verification.

### Closeout

- [ ] Confirm no temporary access, debug logging, test endpoint, local provider adapter, or emergency flag remains enabled.
- [ ] Record final monitoring signoff, open discrepancies, owners, due dates, and release completion time.
