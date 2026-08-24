# Payment reconciliation

## Ownership and safety rules

Finance Operations owns daily reconciliation; the billing service owner owns technical correction; Security joins for suspicious access or signing-key events. Stripe is evidence, not the entitlement authority: signed webhook facts enter the append-only ledger, and the platform recalculates subscription and entitlement projections. Never edit payment, refund, dispute, or webhook ledger rows in place.

Use test mode only outside production. The local deterministic adapter is not live Stripe connectivity and cannot satisfy the external provider release gate.

## Daily procedure

1. Confirm webhook endpoint health, signing-secret version, worker freshness, failed-event count, and oldest entitlement-outbox age.
2. Start one reconciliation run with an idempotent run key. Compare provider invoices, charges, refunds, disputes, customers, subscriptions, amounts, currency, periods, and cancellation flags to local ledger facts.
3. Classify discrepancies as missing internal, missing provider, value mismatch, ambiguous reference, duplicate subscription, or delayed event. Preserve provider object IDs and timestamps; do not copy card or personal data.
4. Replay a verified signed event when the local fact is missing. Route ambiguous ownership, amount/currency mismatch, duplicate active subscriptions, refunds, and disputes to manual review.
5. Run entitlement refresh after ledger correction. Verify the subscription, entitlement assignment, and outbox checkpoint for the affected member.
6. Record counts, cursor, exceptions, approvals, and the next owner. A second Finance operator reviews manual refunds and configuration changes.

## Incident thresholds

Page SEV-1 for unauthorized charges, cross-member ownership, live/test mode mixing, widespread incorrect entitlements, or evidence that ledger history changed. Page SEV-2 for webhook delay beyond the operating SLO, a growing reconciliation backlog, or a provider outage. Pause checkout when ownership or signing integrity is uncertain; continue read-only account access.

## Refunds, disputes, and cancellation

Refunds and disputes append provider facts and recalculate entitlements. A full refund removes the paid entitlement according to policy; partial refunds require Finance review. Cancellation at period end preserves access through the verified period end. Never infer a refund or renewal from the browser redirect. Confirm it from a signed non-live/live event appropriate to the environment and the provider API during reconciliation.

## Key and vendor recovery

When rotating webhook secrets, keep the previous verification secret only for the approved overlap window and document the cutoff. If Stripe is unavailable, retain events and idempotency keys, stop noisy retries, communicate checkout degradation, and reconcile from the last durable cursor after recovery. Do not manufacture provider acknowledgements.

