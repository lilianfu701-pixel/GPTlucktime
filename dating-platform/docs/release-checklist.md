# Release checklist

Every item needs an owner, timestamp, evidence link, and explicit result. A missing external dependency is a failed gate, not a waiver or skip.

## Before release

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

## Release and smoke

- [ ] Record the release artifact, commit, migration version, configuration version, and rollout start.
- [ ] Apply migrations before code only when the documented compatibility order permits it.
- [ ] Smoke sign-in/registration, verification, profile/photo review, discovery/match, messaging/reconnect/block, checkout/webhook/entitlement/cancel/refund, report/restriction/appeal, admin MFA/permissions, and privacy export/deletion.
- [ ] Confirm dashboards and alerts for errors, latency, saturation, queue age, webhook failures, reconciliation discrepancies, moderation backlog, and privacy deadlines.
- [ ] Obtain monitoring signoff from service, Finance, Trust & Safety, Security, and Privacy owners.

## Rollback

- [ ] Define objective rollback thresholds and the decision owner before rollout.
- [ ] Confirm the previous artifact is deployable and migrations do not require unsafe reversal.
- [ ] On rollback, pause incompatible workers, preserve ledger/audit/evidence, deploy the previous artifact, validate critical smoke paths, and reconcile queued/provider events.
- [ ] If data recovery is required, stop affected writes and follow the incident runbook; restore only to an explicitly approved target after disposable restore verification.

## Closeout

- [ ] Confirm no temporary access, debug logging, test endpoint, local provider adapter, or emergency flag remains enabled.
- [ ] Record final monitoring signoff, open discrepancies, owners, due dates, and release completion time.

