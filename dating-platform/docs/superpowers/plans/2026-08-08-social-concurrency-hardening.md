# Social Concurrency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close social outbox, list, idempotency, interaction-policy, ticket-revocation, and real-PostgreSQL concurrency gaps without modifying migration 0021.

**Architecture:** Every operation involving a user pair acquires the two `users` rows in canonical UUID order before inspecting blocks or mutating pair state. List reads acquire the viewer row `FOR SHARE` and perform source-row and public-profile reads in one transaction; the outbox dispatcher uses the same pair-user lock order, then locks the event, rechecks match/block state, invokes an idempotent bounded sender, and finalizes the event before releasing the transaction.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL/PGlite, Vitest, Next.js 16.3.

---

### Task 1: Ledger and hidden-profile block behavior

**Files:**
- Modify: `tests/integration/social/social-repository-pglite.test.ts`
- Modify: `src/db/schema/social.ts`
- Create: `drizzle/0022_social_concurrency_hardening.sql`
- Modify: `src/modules/social/social-repository.ts`

- [ ] **Step 1: Write failing ledger/block tests**

```ts
it("blocks a restricted hidden profile and replays after profile deletion", async () => {
  const first = await repository.block(actor.userId, target.profileId, "stable-block-key");
  await database.delete(schema.profiles).where(eq(schema.profiles.id, target.profileId));
  expect(await repository.block(actor.userId, target.profileId, "stable-block-key")).toEqual(first);
});
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/integration/social/social-repository-pglite.test.ts -t "restricted hidden|profile deletion" --testTimeout=30000 --maxWorkers=1`
Expected: FAIL because new blocks require a visible target and the idempotency ledger cascades with profile deletion.

- [ ] **Step 3: Implement forward-only ledger migration and early replay**

```ts
const replay = await readIdempotency(actorUserId, keyHash);
if (replay) return validateReplay(replay, action, targetProfileId);
return withTargetPair(actorUserId, targetProfileId, operation, action !== "block");
```

Migration 0022 drops only `social_action_idempotency_target_profile_id_profiles_id_fk`, adds owner/created lookup indexing, and adds outbox suppression/lease constraints; it never alters 0021.

- [ ] **Step 4: Run GREEN**

Run the Task 1 test filter; expected PASS.

### Task 2: Pair-guarded interaction policy and ticket validation

**Files:**
- Modify: `tests/integration/social/social-repository-pglite.test.ts`
- Modify: `src/modules/social/social-repository.ts`

- [ ] **Step 1: Write failing guarded-write and ticket-boundary tests**

```ts
await repository.withAllowedInteraction(alice.userId, bob.userId, async (tx) => {
  await tx.insert(messageProbe).values({ senderId: alice.userId, recipientId: bob.userId });
});
expect(await repository.validateRealtimeTicket(alice.userId, bob.userId, revokedBefore)).toBe(false);
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/integration/social/social-repository-pglite.test.ts -t "guarded interaction|ticket" --testTimeout=30000 --maxWorkers=1`
Expected: FAIL because the public transactional guard and concrete ticket validator do not exist.

- [ ] **Step 3: Implement canonical transactional guard**

```ts
export interface InteractionPolicy {
  withAllowedInteraction<T>(actorId: string, targetId: string, write: (tx: SocialTransaction) => Promise<T>): Promise<T>;
  validateRealtimeTicket(actorId: string, targetId: string, issuedAt: Date): Promise<boolean>;
}
```

The guard locks the canonical pair, checks both block directions, then invokes the callback in that same transaction. Ticket validation runs under the same guard and rejects `issuedAt <= revokedBefore`.

- [ ] **Step 4: Run GREEN**

Run the Task 2 filter; expected PASS.

### Task 3: Outbox suppression and guarded dispatcher

**Files:**
- Create: `tests/integration/social/social-outbox-pglite.test.ts`
- Create: `src/modules/social/social-outbox-dispatcher.ts`
- Modify: `src/modules/social/social-repository.ts`
- Modify: `src/db/schema/social.ts`

- [ ] **Step 1: Write failing suppression/dispatcher tests**

```ts
await repository.block(alice.userId, bob.profileId, "block-after-match");
const sender = vi.fn();
expect(await dispatcher.dispatch(eventId, sender)).toEqual({ status: "suppressed" });
expect(sender).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/integration/social/social-outbox-pglite.test.ts --testTimeout=30000 --maxWorkers=1`
Expected: FAIL because blocking does not suppress pending events and no dispatcher exists.

- [ ] **Step 3: Implement dispatcher with one lock order**

```ts
await lockPairUsers(tx, lowUserId, highUserId);
const event = await lockEvent(tx, eventId);
if (!activeOrUnblocked) return suppress(tx, event, "pair_unavailable");
await withTimeout(sender({ eventId, dedupeKey, payload }), timeoutMs);
return publish(tx, eventId);
```

The dispatcher reads pair identity before the transaction, locks pair users first, locks/rechecks the event second, invokes a sender carrying the stable dedupe key, and marks published in the same transaction. Block uses pair-user locks before suppressing pending match events.

- [ ] **Step 4: Run GREEN**

Run the Task 3 test file; expected PASS including deterministic sender-first and block-first barriers.

### Task 4: Linearizable safe social lists

**Files:**
- Modify: `tests/integration/social/social-repository-pglite.test.ts`
- Modify: `src/modules/social/social-repository.ts`

- [ ] **Step 1: Write failing block/list barrier tests for all lists**

```ts
const blockedFirst = repository.listMatches(viewer.userId, { pageSize: 50 });
await blockCommitted;
expect((await blockedFirst).items).toEqual([]);
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/integration/social/social-repository-pglite.test.ts -t "linearizes .* list" --testTimeout=30000 --maxWorkers=1`
Expected: FAIL because list source rows and public profiles are read outside one viewer-locked transaction.

- [ ] **Step 3: Implement viewer-share transaction and final profile policy**

```ts
return database.transaction(async (tx) => {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, viewerId)).for("share");
  const rows = await readBoundedSourceRows(tx, cursor, pageSize);
  return hydratePublicProfiles(tx, viewerId, rows, { recheckBidirectionalBlock: true });
});
```

Hydration rechecks active/discoverable profiles, bidirectional blocks, approved unremoved photos, and visitor privacy. Bounded scanning continues until the page is filled, the source is exhausted, or 200 rows are inspected.

- [ ] **Step 4: Run GREEN**

Run the Task 4 filter and the full social repository test; expected PASS.

### Task 5: Real PostgreSQL two-client evidence

**Files:**
- Create: `tests/integration/social/social-concurrency-postgres.test.ts`

- [ ] **Step 1: Add gated two-pool tests**

```ts
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run("social PostgreSQL concurrency", () => {
  it("serializes reciprocal likes across independent clients", async () => {
    const [left, right] = await Promise.all([leftRepo.like(...), rightRepo.like(...)]);
    expect(await countMatches()).toBe(1);
  });
});
```

The suite creates a unique schema, runs migrations into it, uses two separate `pg.Pool` instances, and releases explicit gates in `finally` blocks. It covers reciprocal likes, same-key/different-target, like-vs-block, and sender-vs-block.

- [ ] **Step 2: Verify gated behavior**

Run: `npm.cmd test -- tests/integration/social/social-concurrency-postgres.test.ts --testTimeout=30000 --maxWorkers=1`
Expected here: suite safely skipped because `TEST_DATABASE_URL` is unset; never claim two-client PostgreSQL coverage passed.

### Task 6: Full verification and delivery

**Files:**
- Verify all modified files

- [ ] **Step 1: Run focused and full gates**

```text
npm.cmd test -- tests/integration/social tests/unit/social tests/integration/discovery tests/unit/discovery --hookTimeout=30000 --testTimeout=30000 --maxWorkers=4
npm.cmd test -- --hookTimeout=30000 --testTimeout=30000 --maxWorkers=4
npm.cmd run lint
node_modules/.bin/tsc.cmd --noEmit
npm.cmd run db:generate
npm.cmd run build
```

- [ ] **Step 2: Security and diff review**

Confirm parameterized queries, stable pair-user lock order, no event/user reverse lock path, no hidden-profile leakage, no secrets, no block notification, migrations start at 0022, and clean `git diff --check`.

- [ ] **Step 3: Commit**

```text
git commit -m "fix: close social concurrency gaps"
```
