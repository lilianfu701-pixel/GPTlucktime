# Worker

Drains the transactional outbox and runs the date-driven schedules.

```bash
npm run worker
```

## What it processes

`worker/handlers.ts` is the registry. The runner claims **only** topics that
appear in it — see `modules/outbox/runner.ts`.

| Topic | Handler |
| --- | --- |
| `search.index` | reindex the memorial, then look for duplicates |
| `memorial.created` | same, for a memorial that has just been made |
| `memorial.privacy_changed` | same, so the index follows the row |
| `search.remove` | drop the memorial's search document |
| `media.process` | scan and derive an uploaded file |

## Topics deliberately left in the queue

These are published by the application and nothing consumes them yet:

| Topic | Waiting on |
| --- | --- |
| `notification.send` | an email/SMS provider (doc 11 §5) |
| `export.requested` | object storage for the archive (doc 11 §5) |
| `commemoration.created` | notification delivery, as above |

They are **not** registered, and that is on purpose. A worker that claimed them
would find no way to do the work and would dead-letter them, which destroys a
family's notification instead of deferring it. Left unclaimed, they wait; the
day a provider is configured they are processed in order, oldest first, and
nothing is lost.

The cost is that they sit in the backlog, so `pending` and `oldestPendingAgeMs`
from `outboxDepth()` will not be zero on a healthy system. That is why
`pendingByTopic` exists: the gap should be readable by name rather than showing
up as a number that quietly climbs. Alert on the topics that *are* registered.

## What is not an event

Purging a deleted memorial happens thirty days after the request. That is a
schedule (`memorialsDueForPurge`), not a queue entry — a retry curve measured in
minutes is the wrong tool for a month, and an event that undeliverable for that
long is indistinguishable from a broken queue to whoever is on call.

Anniversary reminders are a schedule for the same reason.

## Retries

Five attempts, exponential backoff from one second, capped at an hour. A handler
reports `retryable: false` when another attempt cannot help — a rejected file,
a payload that will never parse — and the event is set aside immediately rather
than occupying the queue four more times.

A dead letter is kept forever. It is the record of a side effect that did not
happen. `deadLetters()` lists them; `replayDeadLetter(id)` puts one back with
its attempt count reset, which is a deliberate act after fixing the cause, not
a sixth automatic try.

## Two things that will bite

**Due-ness is decided by the database clock.** `timestamptz` keeps microseconds,
a JavaScript `Date` keeps milliseconds. Comparing an `available_at` read back
into Node against `Date.now()` rounds it down, and an event enqueued in the same
millisecond as a poll is skipped. It also means a worker with a drifted clock
would claim events early or never. Both are avoided by comparing against `now()`
in SQL — do not "simplify" that back into JavaScript.

**The row lock is load-bearing.** Without `for update skip locked` two workers
select the same row and both dispatch it, and a family gets the same
notification twice. The test that proves this only proves it because it warms
the connection pool first: without warming, the two transactions serialize and
the test passes with the lock removed.
