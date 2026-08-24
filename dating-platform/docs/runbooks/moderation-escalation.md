# Moderation escalation

## Ownership and severity

Trust & Safety owns moderation incidents. The safety specialist owns imminent-harm and minor-safety cases; the case worker owns ordinary triage; the appeal reviewer must be different from the moderator responsible for the original enforcement; Legal owns lawful requests and legal holds. Security joins for coordinated abuse or account compromise.

Treat imminent harm, credible threats, minor safety, non-consensual sexual content, or exposure of restricted evidence as SEV-1. Coordinated harassment, large queue failure, or a moderation vendor outage is SEV-2. Never rely solely on automated classification for emergency or final appeal decisions.

## Emergency procedure

1. Preserve the report snapshot, controlled evidence locator, timestamps, integrity hashes, and relevant media version. Do not download or redistribute restricted material outside approved evidence controls.
2. Assign a safety specialist, apply the narrowest immediate restriction needed to stop harm, and escalate to emergency services only under approved policy and Legal guidance.
3. Record every evidence access with actor, role, purpose, and case. Apply a legal hold only with scoped authorization.
4. Notify the incident commander and maintain the SEV-1 cadence until imminent risk is resolved.

## Standard case and appeal flow

Triage the report, assign a case worker, review controlled evidence, record a reasoned action or dismissal, and update the member-visible status. Temporary restrictions require an explicit expiry. The member can appeal from their account. A different appeal reviewer claims and finalizes the appeal; self-review is forbidden. The immutable audit timeline must show report, assignment, evidence access, enforcement, appeal, and final decision.

## Vendor or queue outage

If media review or another moderation provider is unavailable, leave content pending/quarantined and undiscoverable. Retain retryable jobs and evidence references; do not auto-approve on timeout. If the moderation queue is impaired, prioritize emergency cases manually with two-person tracking and backfill all actions into the audited workflow after recovery.

## Privacy, deletion, and legal hold

Deletion does not erase evidence under an active, authorized legal hold. Scope the hold to the case and subject, restrict access, and record release. Without a hold, follow normal retention and deletion deadlines. Export responses exclude internal risk signals, private moderator notes, and other members' data. Escalate any conflict between a deletion deadline and preservation duty to Privacy/Legal immediately.

