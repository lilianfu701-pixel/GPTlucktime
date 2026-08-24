# Incident response

## Ownership and activation

The on-call incident commander owns coordination, severity, timeline, and closure. The service owner investigates application health; Security owns suspected account, credential, or data compromise; Finance owns payment-impact decisions; Trust & Safety owns member-safety events; Privacy/Legal owns export, deletion, retention, and legal-hold decisions. The incident commander records every handoff and names a communications lead. Never place secrets, identity documents, private messages, or payment data in chat or tickets.

Open an incident when an alert is actionable or a person reports credible harm. Acknowledge paging alerts within five minutes, assign owners, preserve timestamps and evidence, and use a dedicated incident channel and log. If ownership is unclear, the incident commander retains it until a named owner accepts.

## Severity

| Severity | Definition | Initial response | Update cadence |
| --- | --- | --- | --- |
| SEV-1 | Active safety threat, confirmed breach, widespread outage, incorrect destructive privacy action, or material payment corruption | Page IC, Security, relevant domain owner, and executive duty lead immediately | Every 15 minutes |
| SEV-2 | Major feature unavailable, elevated fraud, delayed moderation, payment/webhook backlog, or RPO/RTO at risk | Page IC and domain owner within 15 minutes | Every 30 minutes |
| SEV-3 | Limited degradation with a workaround and no evidence of safety, privacy, or financial harm | Service owner during support hours | Hourly or on change |
| SEV-4 | Low-risk defect or documentation issue | Normal backlog | At milestones |

Upgrade severity on uncertainty when safety, privacy, or money may be affected. Downgrade only after evidence is recorded.

## Response sequence

1. Confirm the alert using metrics, traces, sanitized logs, queue depth, and synthetic checks. Record detection time and the earliest known bad event.
2. Contain harm: disable the smallest affected write path, revoke exposed keys, pause a worker, or put the affected vendor integration into fail-closed mode. Do not delete evidence.
3. Preserve evidence and establish legal-hold status before changing retention, exports, messages, photos, billing ledger rows, audit rows, or backups.
4. Recover with an approved rollback or forward fix. A rollback owner verifies migration compatibility and keeps irreversible migrations disabled until recovery is proven.
5. Validate member flows, admin access, queues, webhooks, exports/deletions, and monitoring before declaring recovery.
6. Communicate impact without exposing member data. Close only after the incident commander and affected owner sign off; schedule a blameless review for SEV-1/2.

## Vendor outage

For Stripe, email/SMS, identity verification, media review, Redis, or object storage outages, confirm vendor status independently. Stop retries that could amplify load while retaining durable jobs and idempotency keys. Payment and identity flows fail closed; do not grant entitlements or verification from an unconfirmed response. Media stays pending and undiscoverable. Reconcile every queued operation after recovery before clearing the incident.

## Rollback and recovery

Use the release artifact and migration plan from the release record. Prefer application rollback when the database schema remains backward compatible. Never reverse a destructive migration without a tested recovery plan. For suspected data loss, stop writes, preserve the affected database, run the disposable-target restore verification, record measured RPO/RTO, and obtain database-owner approval before production recovery.

## Privacy workflows and legal hold

Export and deletion queues are safety-critical. During an outage, pause final deletion while allowing requests to remain durably queued. Never mark an export ready without storage integrity verification. Legal hold overrides normal deletion only with a recorded Legal authorization and scoped subject/case identifier; it does not authorize broader access. On release of a hold, resume the original retention workflow and audit the transition. Notify Privacy/Legal of missed deadlines immediately.

