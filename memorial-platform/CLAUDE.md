# Memorial Platform — missingu.org

Global memorial platform for families to create, manage, and share digital memorials.

## Quick Reference

```bash
npm run dev          # Next.js dev server
npm run build        # Production build
npm run typecheck    # tsc --noEmit
npm run test         # Vitest (unit + integration)
npm run test:e2e     # Playwright
npm run db:generate  # Drizzle Kit generate migrations
npm run db:migrate   # Drizzle Kit run migrations
npm run db:seed      # Seed religions, plans, features
npm run worker       # Background job processor
```

## Stack

- **Runtime**: Node >= 22.13.0, TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Framework**: Next.js 16.2.12 (App Router, `force-dynamic` pages, `after()` for post-response work), React 19
- **Database**: PostgreSQL 17 via Drizzle ORM 0.45.2 + `pg` driver
- **Auth**: Email/phone OTP + Google/Apple OAuth, HMAC-SHA256 sessions via `jose`
- **i18n**: next-intl 4.13.4, 15 locales, locale always in URL path
- **Media**: S3-compatible object storage (`@aws-sdk/client-s3`), sharp for image processing
- **Validation**: Zod 4.1.12
- **Cache/Rate-limit**: ioredis 5.8.1 (optional)
- **Tests**: Vitest 4.1.10 (unit + integration), Playwright 1.56.1 (e2e)
- **Deploy**: Vercel (Hobby) + Supabase (ca-central-1) + Cloudflare DNS

## Project Structure

```
app/                    Next.js App Router
  [locale]/             Locale-prefixed pages
    memorials/          Memorial CRUD, view, manage
    search/             Public search
    sign-in/            Auth flow
    admin/              Admin panel
  api/                  API routes (see below)
db/
  schema/               Drizzle table definitions by domain
  seed/                 Seed data (religions, plans, features)
  client.ts             Lazy Pool, SSL auto-detect
drizzle/                Generated SQL migrations (0000–0019)
i18n/                   next-intl routing + request config
lib/                    Shared utilities (env, errors, crypto, logger, result, feature-flags)
messages/               15 locale JSON files
modules/                Domain modules (see below)
scripts/                Operational scripts (backup verification)
tests/                  unit/, integration/, e2e/
worker/                 Background job processor
```

## Domain Modules (`modules/`)

| Module | Purpose |
|--------|---------|
| `auth/` | Email/phone OTP, OAuth (Google/Apple), sessions, cookies |
| `media/` | Presigned upload, quarantine→scan→promote pipeline, S3/InMemory adapters, sharp image processing |
| `memorials/` | Memorial CRUD, access control, content versioning, privacy, export, invitations, SEO, slugs |
| `permissions/` | Pure allow-list policy: `canOnMemorial()` + `canGovern()` |
| `religion/` | Religion/culture catalog, ritual definitions, calendar adapters, anniversary computation |
| `commemorations/` | Visitor acts of remembrance, rate limiting |
| `genealogy/` | Family tree: people, links, double-blind matching, tree traversal |
| `memorials/recognition.ts` | Recognition claim lifecycle: create, decide (confirm/reject), withdraw, escalate, list pending |
| `governance/` | Moderation cases, ownership disputes, memorial merging, reports |
| `search/` | Text search, indexing, duplicate detection |
| `entitlements/` | Plan-based + per-memorial feature resolution |
| `outbox/` | Transactional outbox: claim (SKIP LOCKED), dispatch, backoff, dead letters |
| `audit/` | Read-only audit trail queries |
| `observability/` | Health/readiness probes |

## Database Schema (Drizzle)

Tables organized in `db/schema/` by domain file:

- **system.ts** — `auditLogs`, `outboxEvents`
- **identity.ts** — `users`, `userIdentities`, `emailCredentials`, `phoneCredentials`, `loginChallenges`, `loginAttempts`, `sessions`
- **memorial.ts** — `deceasedPeople`, `memorials`, `memorialNames`, `memorialLocations`, `memorialMembers`, `relationshipClaims`, `recognitionClaims`, `memorialInvitations`, `exportJobs`, `relationshipTypes`
- **content.ts** — `contentVersions`, `contentTranslations`, `biographies`, `timelineEvents`, `tributes`, `visitorSubmissions`
- **media.ts** — `mediaAssets`, `mediaVariants`
- **religion.ts** — `religions`, `denominations`, `culturalTraditions`, `ritualDefinitions`, `ritualVersions`, `ritualSources`, `ritualTranslations`, `ritualCompatibilityRules`
- **commemoration.ts** — `memorialRitualSettings`, `commemorations`, `commemorationMessages`, `anniversaryReminders`
- **governance.ts** — `blockedUsers`, `reports`, `moderationCases`, `moderationActions`, `ownershipDisputes`, `disputeEvidence`, `memorialSlugRedirects`
- **search.ts** — `searchDocuments`, `duplicateCandidates`
- **commerce.ts** — `features`, `plans`, `planEntitlements`, `subscriptions`, `orders`, `memorialEntitlements`
- **genealogy.ts** — `familyPeople`, `familyLinks` (+ `dissolvedAt`/`dissolutionReason` for ex-partner edges), `familyMatchSuggestions`

## API Routes

### Auth
- `POST /api/auth/email/request` — send OTP
- `POST /api/auth/email/verify` — verify OTP, create session
- `POST /api/auth/phone/request` — phone OTP (feature-gated)
- `POST /api/auth/phone/verify` — verify phone OTP
- `POST /api/auth/sign-out` — revoke session

### Memorials
- `POST /api/memorials` — create memorial
- `PUT /api/memorials/[id]/biography` — save draft
- `POST /api/memorials/[id]/biography/publish` — publish biography
- `POST /api/memorials/[id]/publish` — publish memorial
- `PATCH /api/memorials/[id]/privacy` — update visibility
- `POST /api/memorials/[id]/commemorations` — create commemoration
- `GET|PUT /api/memorials/[id]/ritual-settings` — ritual configuration
- `GET /api/memorials/[id]/rituals` — available rituals
- `POST /api/memorials/[id]/members/invitations` — send invitation
- `POST|DELETE /api/memorials/[id]/export` — data export
- `GET|POST /api/memorials/[id]/family` — family tree association
- `GET|PUT /api/memorials/[id]/relatives` — display relatives list (cardinality-enforced: father/mother/husband/wife max 1 each; siblings/children unlimited; ex_husband/ex_wife unlimited)
- `GET|POST /api/memorials/[id]/recognition-claims` — list pending claims / submit a recognition claim
- `POST /api/memorials/[id]/recognition-claims/[claimId]` — decide a claim (confirmed/rejected/withdrawn)

### Media
- `POST /api/media/sign` — presigned upload URL
- `POST /api/media/[id]/complete` — mark upload complete
- `GET /api/media/[id]` — asset status + URL
- `DELETE /api/media/[id]` — soft delete

### Other
- `GET /api/search` — public search
- `POST /api/reports` — submit report
- `GET|POST /api/family/links` — family links
- `POST /api/family/links/[id]` — confirm/reject link
- `POST /api/family/people` — add person to graph
- `GET /api/family/suggestions` — match suggestions
- `POST /api/family/suggestions/[id]` — accept/decline match
- `GET /api/health` — liveness
- `GET /api/health/ready` — readiness (DB + migrations)
- `GET /api/cron/daily` — anniversary reminders + purge (CRON_SECRET)
- `GET /api/cron/outbox` — outbox drain (CRON_SECRET)

## i18n

15 locales: `en`, `zh-CN`, `zh-TW`, `zh-HK`, `es`, `pt-BR`, `pt-PT`, `fr`, `de`, `ar`, `ja`, `ru`, `id`, `vi`, `ko`

- Default: `en`. Launch quality: `en`, `zh-CN`, `es`.
- RTL: `ar` only.
- Locale always in URL path (`localePrefix: "always"`).
- Messages in `messages/{locale}.json`. Top-level keys: `meta`, `common`, `nav`, `home`, `auth`, `memorial`, `privacy`, `religion`, `ritual`, `moderation`, `errors`, `a11y`, `search`.

## Media Pipeline

Upload flow: `signUpload` → presigned PUT URL → client uploads to quarantine prefix → `markUploadComplete` (status `scanning`, publishes `media.process` outbox event) → `processUploadedAsset` (verify magic bytes + re-encode via sharp + promote to ready prefix) → `addressFor` (public or signed read URL).

Security invariants:
- SVG excluded (XSS vector)
- EXIF/GPS stripping via sharp `.rotate()` + re-encode (not just metadata strip)
- Object keys from server UUIDs only (no client filename in key)
- Signed read URLs: 5-min TTL
- Public URLs only for ready assets on public memorials
- Magic-byte signature verification (`signatureMatchesDeclared`)
- Sharp re-encode replaces malware scanner on image path (decode to pixels + re-encode = sanitization)
- Video/audio disabled at launch (require AV scanner)
- Error responses never contain storage keys

Storage adapters: `S3MediaStorage` (production) and `InMemoryMediaStorage` (dev/test). Factory in `mediaStorage()` auto-selects based on env vars.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `APP_URL` | yes | Base URL (https) |
| `SESSION_SECRET` | yes | Min 32 chars, HMAC key |
| `DATABASE_URL` | yes | postgres:// connection string |
| `REDIS_URL` | no | Rate limiting, caching |
| `S3_BUCKET` | no* | Object storage bucket |
| `S3_REGION` | no* | S3 region |
| `S3_ACCESS_KEY_ID` | no* | S3 credentials |
| `S3_SECRET_ACCESS_KEY` | no* | S3 credentials |
| `S3_ENDPOINT` | no | Custom endpoint (R2, MinIO) |
| `S3_FORCE_PATH_STYLE` | no | `true` for R2/MinIO |
| `S3_PUBLIC_BASE_URL` | no | CDN base for public media |
| `EMAIL_PROVIDER` | no | Default: `console` |
| `SMS_PROVIDER` | no | Default: `console` |
| `CRON_SECRET` | no | Bearer token for cron routes |
| `GOOGLE_CLIENT_ID/SECRET` | no | Google OAuth |
| `APPLE_CLIENT_ID/PRIVATE_KEY` | no | Apple OAuth |
| `PHONE_AUTH_ENABLED` | no | Default: `false` |
| `PHONE_AUTH_REGIONS` | no | Comma-separated ISO codes |
| `ANNIVERSARY_NOTIFICATIONS_ENABLED` | no | Default: `false` |

*S3 vars required in production for media uploads.

## Worker

Entry: `worker/index.ts` (`npm run worker`). Processes:
- **Outbox drain** — continuous, claim with `FOR UPDATE SKIP LOCKED`
- **Anniversary reminders** — every 5 min
- **Memorial purge** — every hour
- **Depth report** — every minute

Outbox handler topics: `search.index`, `search.remove`, `memorial.created`, `memorial.published`, `memorial.privacy_changed`, `media.process`.

On Vercel: outbox drain and daily jobs run via cron (`vercel.json`), not the standalone worker.

## Relatives System

Display-layer relatives (`memorial_relatives`) are free-text rows shown on the memorial page. They are separate from the graph-based genealogy (`familyPeople`/`familyLinks`).

### Cardinality rules (enforced in UI + server-side PUT)

| Relationship | Max count | Note |
|---|---|---|
| `father`, `mother` | 1 each | Biological/primary parents |
| `husband`, `wife` | 1 each | Current spouse |
| `ex_husband`, `ex_wife` | unlimited | Multiple prior marriages allowed |
| `son`, `daughter` | unlimited | |
| `older_brother`, `younger_brother`, `older_sister`, `younger_sister` | unlimited | |

The `MAX_ONE` set is defined as a `ReadonlySet<string>` constant in both `relatives-editor.tsx` and `create-form.tsx`. The same set is duplicated in the PUT route for server-side enforcement. Keep all three in sync when adding new unique-relationship types.

### Recognition claim system (三层认亲机制)

When a registered user finds they've been listed as a relative, they can submit a recognition claim:

- **Tier 1 (day 0):** Claim recorded as `pending`; memorial owner notified.
- **Tier 2 (day 7, 14):** Automatic reminder notifications (via outbox, not yet wired).
- **Tier 3 (day 30+):** Claimant may request platform arbitration (`escalated` status).
- Auto-approval **never** happens — a confirmed link grants family-graph traversal rights.

Service: `modules/memorials/recognition.ts`. Status enum: `pending → escalated → confirmed | rejected | withdrawn`.

### Ex-spouse in the family graph

Ex-spouses are represented as `partner` edges in `familyLinks` with `dissolvedAt` + `dissolutionReason` set. A CHECK constraint (`family_links_dissolution_ck`) ensures these columns are null on non-partner edges. Children from previous marriages need no special type — existing `parent` edges represent biological parentage.

## Architectural Patterns

- **Result type** — services return `Result<T, E>` (discriminated union), not throws, for business failures
- **Error codes** — 18 stable codes with fixed HTTP status mappings; messages never from caller input
- **Transactional outbox** — events committed in same DB transaction as business changes; exponential backoff; max 5 attempts; dead-letter
- **Permissions** — pure allow-list functions, no middleware magic: `canOnMemorial(actor, role, action)` + `canGovern(actor, action)`
- **Access control** — invite-only memorials return 404 (not 403) to prevent existence confirmation
- **Content versioning** — immutable `contentVersions` rows; biography has `publishedVersionId` + `latestVersion`
- **Structured logging** — JSON per line, key-based redaction (passwords, tokens, emails, phones)
- **Crypto** — HKDF from SESSION_SECRET with purpose separation; timing-safe comparison
- **Feature flags** — derived from env at startup (`lib/feature-flags.ts`)

## Testing

- **Unit** (17 suites in `tests/unit/`) — run in parallel
- **Integration** (19 suites in `tests/integration/`) — run sequentially, share one PostgreSQL + Redis
- **E2E** (8 specs in `tests/e2e/`) — Playwright, Chromium, port 3100

Vitest env from `.env.test`. Playwright starts dev server automatically.

## Deployment

- **Git**: `lilianfu701-pixel/onememora` on GitHub, branch `codex/global-memorial-platform`
- **Vercel**: push to `main` triggers deploy
- **Supabase**: PostgreSQL in `ca-central-1`
- **Cloudflare**: DNS for missingu.org
- **Cron**: daily at 04:00 UTC (anniversaries + purge), 04:20 UTC (outbox)

## Security Checklist

- Session tokens: HMAC-SHA256, httpOnly, secure, sameSite=lax
- OTP: hashed before storage, max 3 attempts, 10-min expiry, lockout
- CSRF: POST-only mutations, sameSite cookies
- Headers: HSTS, X-Frame-Options DENY, nosniff, strict Referrer-Policy, Permissions-Policy
- Media: no SVG, magic-byte check, EXIF strip, server-generated keys only
- Audit: append-only log for all state changes
- Env: validated at startup via Zod; missing secrets fail closed
- Errors: codes only, never echo internal state or storage keys
