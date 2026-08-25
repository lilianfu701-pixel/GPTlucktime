# DateCN Free Vercel Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing DateCN application fully usable on Vercel Hobby without a persistent WebSocket process or paid object storage.

**Architecture:** Keep PostgreSQL as the source of truth. Add an HTTP polling transport that reuses the existing message recovery and receipt services, and add a Vercel Blob adapter behind the existing `StorageAdapter` boundary. A guarded free-test notification adapter supports only synthetic `@datecn.test` addresses and never sends an external message.

**Tech Stack:** Next.js 16.3 App Router, React 19, TypeScript, Vitest, Better Auth, Drizzle/PostgreSQL, Redis, `@vercel/blob`.

---

### Task 1: Add the HTTP receipt write endpoint

**Files:**
- Modify: `src/modules/messaging/message-service.ts`
- Modify: `src/app/api/v1/conversations/[conversationId]/receipts/route.ts`
- Test: `tests/unit/messaging/message-service.test.ts`

- [ ] **Step 1: Write failing route tests**

Add cases that send `POST` with `{ messageId, kind, at }`, assert that the route injects the path `conversationId`, calls `receipts.record(userId, payload)`, and returns 200. Add 400 cases for malformed JSON, extra fields, an invalid UUID, and a body larger than 1,024 bytes; add 401 and repository-unavailable cases.

```ts
const response = await handler(new Request(`https://datecn.test/api/v1/conversations/${conversationId}/receipts`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messageId, kind: "read", at: "2026-08-24T20:00:00.000Z" }),
}), { params: Promise.resolve({ conversationId }) });
expect(response.status).toBe(200);
expect(record).toHaveBeenCalledWith(userId, {
  conversationId, messageId, kind: "read", at: "2026-08-24T20:00:00.000Z",
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/messaging/message-service.test.ts`  
Expected: FAIL because the handler rejects `POST` with `METHOD_NOT_ALLOWED`.

- [ ] **Step 3: Implement bounded POST handling**

Extend the dependency type to `Pick<MessageReceiptService, "listVisible" | "record">`. For `POST`, read at most 1,024 bytes with the existing bounded JSON helper, validate this strict shape, and pass the path conversation ID separately:

```ts
const receiptWrite = z.object({
  messageId: uuid,
  kind: z.enum(["delivered", "read"]),
  at: z.string().datetime({ offset: true }),
}).strict();

const parsed = receiptWrite.safeParse(payload);
if (!parsed.success) return errorResponse("INVALID_RECEIPT", 400);
return Response.json(await input.receipts.record(session.user.id, {
  conversationId,
  ...parsed.data,
}));
```

Export the same handler as both methods:

```ts
const handler = createMessageReceiptsHandler(messagingRouteDependencies);
export const GET = handler;
export const POST = handler;
```

- [ ] **Step 4: Run focused tests**

Run: `corepack pnpm vitest run tests/unit/messaging/message-service.test.ts tests/integration/realtime/authorization-receipts-pglite.test.ts`  
Expected: both files PASS.

- [ ] **Step 5: Commit**

```text
git add src/modules/messaging/message-service.ts src/app/api/v1/conversations/[conversationId]/receipts/route.ts tests/unit/messaging/message-service.test.ts
git commit -m "feat: expose authorized message receipts over http"
```

### Task 2: Add a bounded polling message transport

**Files:**
- Create: `src/modules/messaging/polling-client.ts`
- Create: `tests/unit/messaging/polling-client.test.ts`
- Modify: `src/app/[locale]/(member)/messages/messages-client.tsx`
- Modify: `src/app/[locale]/(member)/messages/page.tsx`
- Test: `tests/unit/datecn-ui/member-shell.test.tsx`

- [ ] **Step 1: Write failing polling lifecycle tests**

Use fake timers. Verify immediate recovery, one recovery per two seconds while visible, no overlapping request, pause while hidden, immediate catch-up on visibility restoration, bounded exponential retry, receipt POST, and complete cancellation after `stop()`.

```ts
const client = createPollingMessageClient({
  intervalMs: 2_000,
  recover,
  sendReceipt,
  onState,
  onMessages,
});
await client.join(conversationId);
await vi.advanceTimersByTimeAsync(2_000);
expect(recover).toHaveBeenCalledTimes(2);
client.stop();
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/messaging/polling-client.test.ts`  
Expected: FAIL because `polling-client.ts` does not exist.

- [ ] **Step 3: Implement the polling client**

Expose the same methods used by the page: `start`, `join`, `refresh`, `markDelivered`, `markRead`, and `stop`. Reuse `RealtimeMessageStore`, `CoalescedRecovery`, and `ReceiptDeliveryQueue`; schedule with `setTimeout` only after the previous recovery settles so requests never overlap.

```ts
export function createPollingMessageClient(options: PollingClientOptions) {
  const store = new RealtimeMessageStore();
  const joined = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped || document.visibilityState !== "visible") return schedule();
    for (const id of joined) await recoverOne(id);
    schedule();
  };

  const schedule = () => {
    if (!stopped) timer = setTimeout(() => { void tick(); }, options.intervalMs ?? 2_000);
  };

  return { start: async () => { options.onState("online"); schedule(); }, join, refresh,
    markDelivered, markRead, stop };
}
```

Receipt writes use the new route and same-origin credentials:

```ts
await fetch(`/api/v1/conversations/${encodeURIComponent(message.conversationId)}/receipts`, {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messageId: message.id, kind, at }),
  signal,
});
```

- [ ] **Step 4: Wire the page to select WebSocket or polling**

When `REALTIME_PUBLIC_URL` is absent, construct the polling client, report `online` after the first successful recovery, and show the existing localized state badge instead of `unavailable`. Keep the WebSocket path unchanged for future production use.

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm vitest run tests/unit/messaging/polling-client.test.ts tests/unit/datecn-ui/member-shell.test.tsx tests/integration/realtime/delivery.test.ts`  
Expected: all files PASS.

- [ ] **Step 6: Commit**

```text
git add src/modules/messaging/polling-client.ts tests/unit/messaging/polling-client.test.ts src/app/[locale]/(member)/messages/messages-client.tsx src/app/[locale]/(member)/messages/page.tsx tests/unit/datecn-ui/member-shell.test.tsx
git commit -m "feat: add free-tier message polling transport"
```

### Task 3: Add Vercel Blob behind the media boundary

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`
- Modify: `src/shared/env.ts`
- Create: `src/modules/profiles/vercel-blob-storage.ts`
- Modify: `src/modules/profiles/media-runtime.ts`
- Create: `tests/unit/profiles/vercel-blob-storage.test.ts`
- Modify: `tests/unit/env.test.ts`

- [ ] **Step 1: Install the supported Blob SDK**

Run: `corepack pnpm add @vercel/blob@^2.6.1`  
Expected: `package.json` and `pnpm-lock.yaml` contain `@vercel/blob`.

- [ ] **Step 2: Write failing adapter and environment tests**

Cover signed PUT creation, exact-path `head`, ETag-conditional copy, bounded prefix read through a signed GET, delete, 404-to-null mapping, timeout mapping, and rejection when both S3 and Blob media backends are configured.

```ts
const adapter = new VercelBlobStorageAdapter({ token: "vercel_blob_rw_test", requestTimeoutMs: 50 }, sdk);
expect(await adapter.createPutUrl({ objectKey, mimeType: "image/png", sizeBytes: 24, expiresInSeconds: 60 }))
  .toMatch(/^https:\/\//u);
```

- [ ] **Step 3: Run the tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/profiles/vercel-blob-storage.test.ts tests/unit/env.test.ts`  
Expected: FAIL because Blob configuration and adapter do not exist.

- [ ] **Step 4: Add explicit Blob configuration validation**

Add `BLOB_READ_WRITE_TOKEN` as an optional server-only secret. Require `PROFILE_MEDIA_TOKEN_SECRET` whenever either Blob or the complete S3 group is active, and reject simultaneous Blob and S3 media configuration.

```ts
if (env.BLOB_READ_WRITE_TOKEN && env.PROFILE_MEDIA_STORAGE_ENDPOINT) {
  context.addIssue({ code: "custom", message: "configure exactly one profile media backend",
    path: ["BLOB_READ_WRITE_TOKEN"] });
}
if ((env.BLOB_READ_WRITE_TOKEN || env.PROFILE_MEDIA_STORAGE_ENDPOINT) && !env.PROFILE_MEDIA_TOKEN_SECRET) {
  context.addIssue({ code: "custom", message: "PROFILE_MEDIA_TOKEN_SECRET is required",
    path: ["PROFILE_MEDIA_TOKEN_SECRET"] });
}
```

- [ ] **Step 5: Implement `VercelBlobStorageAdapter`**

Implement `StorageAdapter` with `issueSignedToken`, `presignUrl`, `head`, `copy`, and `del`. Use private access, exact pathnames, `addRandomSuffix: false`, `allowOverwrite: false`, ETag conditions, and `AbortSignal.timeout`. Set `versionId` to the immutable ETag because Blob exposes conditional object identity through ETags rather than S3 version IDs.

```ts
const signed = await issueSignedToken({ operations: ["put"], token: this.token });
const { presignedUrl } = await presignUrl(signed, {
  pathname: input.objectKey,
  operation: "put",
  validUntil: Date.now() + Math.min(input.expiresInSeconds, 600) * 1_000,
});
return presignedUrl;
```

- [ ] **Step 6: Select Blob at runtime without changing S3 behavior**

```ts
export const profileMediaStorage = env.BLOB_READ_WRITE_TOKEN
  ? new VercelBlobStorageAdapter({ token: env.BLOB_READ_WRITE_TOKEN })
  : completeS3Configuration(env)
    ? new S3StorageAdapter(s3Configuration(env))
    : null;
```

- [ ] **Step 7: Run media and environment tests**

Run: `corepack pnpm vitest run tests/unit/profiles/vercel-blob-storage.test.ts tests/unit/profiles/media-service.test.ts tests/unit/env.test.ts`  
Expected: all files PASS.

- [ ] **Step 8: Commit**

```text
git add package.json pnpm-lock.yaml .env.example src/shared/env.ts src/modules/profiles/vercel-blob-storage.ts src/modules/profiles/media-runtime.ts tests/unit/profiles/vercel-blob-storage.test.ts tests/unit/env.test.ts
git commit -m "feat: support private Vercel Blob profile media"
```

### Task 4: Add a safe synthetic test notification path

**Files:**
- Modify: `src/shared/env.ts`
- Create: `src/modules/auth/free-test-notification-adapter.ts`
- Modify: `src/modules/auth/auth.ts`
- Create: `src/app/api/free-test/mailbox/route.ts`
- Modify: `src/app/[locale]/(auth)/sign-in/sign-in-form.tsx`
- Modify: `messages/en.json`
- Modify: `messages/zh-CN.json`
- Create: `tests/unit/auth/free-test-notification-adapter.test.ts`
- Modify: `tests/unit/datecn-ui/sign-in-form-tabs.test.tsx`

- [ ] **Step 1: Write failing safety tests**

Require `FREE_TEST_MODE=1` and a 32-character `FREE_TEST_ACCESS_SECRET`; reject this mode unless `APP_URL` is HTTPS and `STRIPE_SECRET_KEY`, email webhooks, SMS webhooks, and identity provider settings are absent. Verify that only `@datecn.test` recipients are accepted, mailbox items expire after 15 minutes, URLs are returned only with the access secret, and password-reset/verification URLs are never logged.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/auth/free-test-notification-adapter.test.ts tests/unit/env.test.ts`  
Expected: FAIL because free-test mode is not implemented.

- [ ] **Step 3: Implement the Redis-backed synthetic mailbox**

Store encrypted one-time notification payloads under HMAC-derived keys with a 15-minute TTL. The adapter implements `MessageSender` and `MessageDispatcher`, refuses non-test addresses, and never calls an external URL.

```ts
if (!recipient.toLowerCase().endsWith("@datecn.test")) {
  throw new Error("FREE_TEST_RECIPIENT_REQUIRED");
}
await redis.set(mailboxKey(recipient), encryptedPayload, { EX: 900 });
```

- [ ] **Step 4: Add the guarded mailbox route and test UI**

The route accepts `POST { email, accessCode }`, uses constant-time comparison for the access code, returns only the newest unexpired synthetic verification link, and rate-limits by HMAC of client bucket and email. The registration panel displays the mailbox control only when a server-provided `freeTestMode` prop is true.

- [ ] **Step 5: Run auth tests**

Run: `corepack pnpm vitest run tests/unit/auth/free-test-notification-adapter.test.ts tests/unit/datecn-ui/sign-in-form-tabs.test.tsx tests/unit/auth`  
Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```text
git add src/shared/env.ts src/modules/auth/free-test-notification-adapter.ts src/modules/auth/auth.ts src/app/api/free-test/mailbox/route.ts src/app/[locale]/(auth)/sign-in/sign-in-form.tsx messages/en.json messages/zh-CN.json tests/unit/auth/free-test-notification-adapter.test.ts tests/unit/datecn-ui/sign-in-form-tabs.test.tsx tests/unit/env.test.ts
git commit -m "feat: add guarded synthetic signup mailbox"
```

### Task 5: Mark every page as a free test environment

**Files:**
- Create: `src/components/datecn/free-test-banner.tsx`
- Modify: `src/app/[locale]/layout.tsx`
- Modify: `messages/en.json`
- Modify: `messages/zh-CN.json`
- Modify: `tests/unit/datecn-ui/public-pages.test.ts`
- Modify: `tests/unit/datecn-ui/responsive-contract.test.ts`

- [ ] **Step 1: Write failing presentation tests**

Verify the locale layout reads the server-only `FREE_TEST_MODE` flag, renders a localized banner only when it equals `1`, and that the banner text says test data, no real payment, and no real email/SMS. Verify a 390-pixel layout contract with no fixed width wider than the viewport.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/datecn-ui/public-pages.test.ts tests/unit/datecn-ui/responsive-contract.test.ts`  
Expected: FAIL because the global test banner does not exist.

- [ ] **Step 3: Implement the server-controlled banner**

```tsx
export function FreeTestBanner({ children }: { children: React.ReactNode }) {
  return <aside className="w-full bg-amber-100 px-4 py-2 text-center text-sm text-amber-950"
    role="status">{children}</aside>;
}
```

Render it before page content only when `readEnv(process.env).FREE_TEST_MODE === "1"`. Keep the value server-side; do not introduce a `NEXT_PUBLIC_` secret or flag.

- [ ] **Step 4: Run focused tests and commit**

Run: `corepack pnpm vitest run tests/unit/datecn-ui/public-pages.test.ts tests/unit/datecn-ui/responsive-contract.test.ts`  
Expected: PASS.

```text
git add src/components/datecn/free-test-banner.tsx src/app/[locale]/layout.tsx messages/en.json messages/zh-CN.json tests/unit/datecn-ui/public-pages.test.ts tests/unit/datecn-ui/responsive-contract.test.ts
git commit -m "feat: label the free public test environment"
```

### Task 6: Complete compatibility verification

**Files:**
- Modify: `docs/release-checklist.md`
- Create: `docs/runbooks/free-test-deployment.md`

- [ ] **Step 1: Run the complete unit and integration suite**

Run: `corepack pnpm test`  
Expected: 0 failed tests; the previously recorded intentional skips remain documented.

- [ ] **Step 2: Run type, lint, and production build checks**

Run: `corepack pnpm exec tsc --noEmit`  
Expected: exit 0.  
Run: `corepack pnpm lint`  
Expected: exit 0.  
Run: `corepack pnpm build`  
Expected: exit 0 and all application routes compile.

- [ ] **Step 3: Document free-test limits and recovery**

Record polling latency, Blob quotas, synthetic-email restriction, no real payments, required environment names, and how to disable `FREE_TEST_MODE`.

- [ ] **Step 4: Commit**

```text
git add docs/release-checklist.md docs/runbooks/free-test-deployment.md
git commit -m "docs: record free test deployment controls"
```
