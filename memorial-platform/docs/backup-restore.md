# Backup and restore

A backup nobody has restored is not a backup, it is a file.

```bash
npm run verify:backup -- --in-place
```

## What the rehearsal does

`scripts/verify-backup.ts` counts rows in the tables that matter, takes a real
`pg_dump`, restores it, and compares. Two modes:

- **default** — restores into a scratch database beside the source, compares,
  drops it. This is the mode to run against production. It needs a role with
  `CREATEDB`.
- **`--in-place`** — empties the configured database and rebuilds it from the
  dump. More faithful, because reconstituting a database from nothing but the
  dump is the actual disaster. Destructive, so it refuses any database whose
  name does not end in `_test`, with no override.

The dump stays on disk until the run finishes. If a restore fails, the failure
message says where it is.

## Last verified

**2026-07-30**, `--in-place` against `memorial_test`, PostgreSQL 17.

```
dump written    : 259265 bytes
database emptied
  ok   religions              14 -> 14
  ok   ritual_definitions     15 -> 15
  ok   outbox_events          116 -> 116
  ok   audit_logs             1453 -> 1453
  ok   __migrations           18 -> 18
indexes restored: 137
restore verified
```

The full test suite — 778 tests — was then run against the restored database and
passed. That is the check that matters: a restore that answers connections is
not the same as a restore the application can use.

## Known limitation on this machine

The default (scratch database) mode has **not** been exercised here. The
`memorial` role has no `CREATEDB` privilege and the local `postgres` superuser
is not password-accessible from this environment, so only the `--in-place` path
has actually been run. Before relying on the scratch mode in production, run it
once against a staging database with a role that can create one:

```sql
ALTER ROLE <role> CREATEDB;
```

## What is not covered

- **Object storage.** Media and export archives live outside PostgreSQL. There
  is no storage provider configured yet (doc 11 §5), so there is nothing to back
  up and nothing to rehearse. When one is chosen, its restore belongs here too —
  a database restored without its photographs is a memorial with empty frames.
- **Point-in-time recovery.** This rehearses a full dump and restore. Continuous
  archiving and PITR are a hosting decision (doc 09 §7) and are not exercised
  by this script.
- **Redis.** Nothing durable is kept there. Rate-limit counters may be lost
  without consequence.

## If you are restoring for real

1. Stop the workers first. A worker running against a half-restored database
   will claim outbox events and dead-letter them.
2. Restore, then check `/api/health/ready`. It reports `migrations_pending` if
   the schema came back behind the deployed build — which is what a restore from
   an older dump looks like.
3. Run the migrations before starting the workers again.
4. Re-run this script afterwards, so the next person knows the date above is
   still true.
