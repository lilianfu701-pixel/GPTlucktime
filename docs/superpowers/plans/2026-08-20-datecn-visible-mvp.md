# DateCN Visible MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished, bilingual, responsive DateCN demo experience covering the homepage, authentication, discovery, matches, profiles, messages, membership, and mobile navigation without touching real user data or payment providers.

**Architecture:** Keep all demo content behind a read-only `src/modules/demo` boundary and route visible demos under `/{locale}/demo/*`, while improving the public homepage and sign-in screen in place. Shared DateCN components provide the visual system and navigation. Production member routes and APIs remain authenticated and unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, next-intl, Vitest, Testing Library, Playwright.

---

## File map

- `src/modules/demo/demo-types.ts` — immutable demo-domain types.
- `src/modules/demo/demo-data.ts` — fixed bilingual profiles, conversations, plans, and account data.
- `src/modules/demo/demo-service.ts` — locale-aware read-only selectors; never imports DB/API clients.
- `src/components/datecn/*` — shared visual components and inline SVG icons.
- `src/app/[locale]/demo/*` — demo member pages.
- `src/app/[locale]/(marketing)/page.tsx` — production public homepage, including demo entry.
- `src/app/[locale]/(auth)/sign-in/*` — polished sign-in/register presentation.
- `messages/en.json`, `messages/zh-CN.json` — all new visible copy.
- `public/demo/*` — original generated visual assets only.
- `tests/unit/demo/*`, `tests/unit/datecn-ui/*`, `tests/contract/datecn-visible-mvp.test.ts` — isolated UI and route contracts.
- `tests/e2e/datecn-visible-mvp.spec.ts` — 360px and desktop navigation/overflow check.

### Task 1: Preserve the baseline and add original demo assets

**Files:**
- Verify: `docs/superpowers/development-log-2026-08-20-datecn.md`
- Verify: `docs/superpowers/specs/2026-08-20-datecn-visible-mvp-design.md`
- Create: `dating-platform/public/demo/datecn-hero.webp`
- Create: `dating-platform/public/demo/profile-sprite.webp`

- [ ] **Step 1: Verify the privacy checkpoint before UI work**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run --maxWorkers=1 tests/integration/profiles/privacy-repository-pglite.test.ts tests/unit/profiles/data-export-service.test.ts tests/unit/profiles/privacy-schema.test.ts
```

Expected: 3 files and 13 tests pass; no production file changes are needed.

- [ ] **Step 2: Commit the saved development checkpoint**

Stage only the Task 13 files plus the two factual documents, verify the staged diff, and commit:

```powershell
git diff --cached --check
git commit -m "feat: add localization and privacy workflows"
```

Expected: worktree is clean before starting visible UI work.

- [ ] **Step 3: Generate original visual assets**

Use the image-generation tool to create:

```text
datecn-hero.webp: warm editorial photograph of a diverse international couple in a sunlit city café, mature dating brand, cream and burgundy wardrobe, no text, no logos, 16:10.

profile-sprite.webp: a clean 4x2 grid containing eight distinct adult portrait photographs, balanced genders and ethnicities, ages 25–42, neutral warm backgrounds, equal cells, no text, no borders, 2:1 overall ratio.
```

Expected: assets are original and contain no ChinaLoveCupid trademarks or copied imagery.

- [ ] **Step 4: Verify image files**

Run:

```powershell
Get-Item public\demo\datecn-hero.webp,public\demo\profile-sprite.webp | Select-Object Name,Length
```

Expected: both files exist and have non-zero lengths.

### Task 2: Add the read-only demo domain

**Files:**
- Create: `dating-platform/src/modules/demo/demo-types.ts`
- Create: `dating-platform/src/modules/demo/demo-data.ts`
- Create: `dating-platform/src/modules/demo/demo-service.ts`
- Test: `dating-platform/tests/unit/demo/demo-service.test.ts`

- [ ] **Step 1: Write the failing isolation test**

```ts
import {describe, expect, it, vi} from "vitest";
import {getDemoHome, getDemoProfile} from "@/modules/demo/demo-service";

describe("demo service", () => {
  it("returns stable multilingual data without network or database access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = getDemoHome("en");
    const second = getDemoHome("en");
    expect(second).toEqual(first);
    expect(first.profiles).toHaveLength(8);
    expect(getDemoProfile("demo-lina", "zh-CN")?.city).toBe("上海");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and observe RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/demo/demo-service.test.ts
```

Expected: FAIL because `@/modules/demo/demo-service` does not exist.

- [ ] **Step 3: Add immutable types and fixture data**

Define the public contract in `demo-types.ts`:

```ts
export type DemoLocale = "en" | "zh-CN";

export type DemoProfile = Readonly<{
  id: string;
  name: string;
  age: number;
  city: string;
  country: string;
  relationshipGoal: string;
  occupation: string;
  bio: string;
  interests: readonly string[];
  verified: boolean;
  online: boolean;
  compatibility: number;
  spritePosition: `${number}% ${number}%`;
}>;

export type DemoConversation = Readonly<{
  id: string;
  profileId: string;
  unread: number;
  messages: readonly Readonly<{id: string; from: "me" | "them"; text: string; time: string}>[];
}>;
```

Create eight profiles covering multiple regions, genders, and relationship goals. Keep all arrays and returned objects read-only.

- [ ] **Step 4: Implement locale-aware selectors**

```ts
export function getDemoHome(locale: DemoLocale) {
  return {
    profiles: demoProfiles[locale],
    conversations: demoConversations[locale],
    currentUser: demoCurrentUser[locale],
    plans: demoPlans[locale],
  } as const;
}

export function getDemoProfile(id: string, locale: DemoLocale) {
  return demoProfiles[locale].find((profile) => profile.id === id) ?? null;
}
```

Do not import `db`, `fetch`, Stripe, Redis, message repositories, or server environment variables.

- [ ] **Step 5: Run GREEN**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/demo/demo-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/modules/demo dating-platform/tests/unit/demo dating-platform/public/demo
git commit -m "feat: add isolated DateCN demo data"
```

### Task 3: Build the DateCN visual system and responsive shell

**Files:**
- Modify: `dating-platform/src/app/globals.css`
- Create: `dating-platform/src/components/datecn/datecn-icons.tsx`
- Create: `dating-platform/src/components/datecn/demo-banner.tsx`
- Create: `dating-platform/src/components/datecn/site-header.tsx`
- Create: `dating-platform/src/components/datecn/member-shell.tsx`
- Create: `dating-platform/src/components/datecn/mobile-nav.tsx`
- Create: `dating-platform/src/components/datecn/profile-card.tsx`
- Create: `dating-platform/src/app/[locale]/demo/layout.tsx`
- Test: `dating-platform/tests/unit/datecn-ui/member-shell.test.tsx`

- [ ] **Step 1: Write the failing navigation test**

```tsx
render(<MemberShell locale="en" active="discover"><div>Demo body</div></MemberShell>);
expect(screen.getByRole("link", {name: "Discover"})).toHaveAttribute("aria-current", "page");
expect(screen.getByRole("navigation", {name: "Mobile navigation"})).toBeInTheDocument();
expect(screen.getByText("Demo mode")).toBeInTheDocument();
```

- [ ] **Step 2: Run RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/member-shell.test.tsx
```

Expected: FAIL because shared DateCN components are missing.

- [ ] **Step 3: Add global design tokens**

Add these CSS custom properties and reusable utilities to `globals.css`:

```css
:root {
  --datecn-wine: #8f2638;
  --datecn-wine-deep: #6f1d2d;
  --datecn-cream: #fff9f3;
  --datecn-gold: #d4a95d;
  --datecn-ink: #2d2023;
  --datecn-muted: #806b70;
  --datecn-card: #ffffff;
  --datecn-ring: #eaded8;
}

body { background: var(--datecn-cream); color: var(--datecn-ink); }
:focus-visible { outline: 3px solid var(--datecn-gold); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; } }
```

- [ ] **Step 4: Implement composable shell components**

`MemberShell` must render `DemoBanner`, desktop header, desktop sidebar at `lg`, main content, and bottom navigation below `md`. Use links under `/${locale}/demo/*` only. Inline SVG icons must have `aria-hidden="true"`; links carry translated accessible names.

- [ ] **Step 5: Run GREEN and accessibility assertions**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/member-shell.test.tsx
```

Expected: PASS with no missing accessible names.

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/app/globals.css dating-platform/src/components/datecn dating-platform/src/app/[locale]/demo dating-platform/tests/unit/datecn-ui/member-shell.test.tsx
git commit -m "feat: add responsive DateCN member shell"
```

### Task 4: Redesign the homepage and authentication experience

**Files:**
- Modify: `dating-platform/src/app/[locale]/(marketing)/page.tsx`
- Modify: `dating-platform/src/app/[locale]/(auth)/sign-in/page.tsx`
- Modify: `dating-platform/src/app/[locale]/(auth)/sign-in/sign-in-form.tsx`
- Modify: `dating-platform/messages/en.json`
- Modify: `dating-platform/messages/zh-CN.json`
- Test: `dating-platform/tests/unit/datecn-ui/public-pages.test.tsx`

- [ ] **Step 1: Write failing public-page tests**

Assert the homepage contains the DateCN brand, free demo link, member preview, three-step section, trust section, membership teaser, and responsive sign-in link. Assert the sign-in page exposes sign-in and create-account tabs without invoking any API during render.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/public-pages.test.tsx
```

Expected: FAIL because the current homepage has only a short hero and two text sections.

- [ ] **Step 3: Implement the homepage sections**

Use this order:

```text
SiteHeader → Hero with original image → Trust strip → Demo profile rail →
Three-step explanation → Membership teaser → Safety statement → Footer
```

The primary hero button links to `/${locale}/demo/discover`; the secondary button links to `/${locale}/sign-in`. Every visible string comes from `next-intl`.

- [ ] **Step 4: Polish sign-in and registration**

Keep the existing authenticated submission behavior. Add a visual side panel, sign-in/create-account tabs, password visibility control, trust copy, and a non-submitting demo link. Do not bypass authentication or prefill secrets.

- [ ] **Step 5: Run GREEN and locale contracts**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/public-pages.test.tsx tests/contract/locale-contract.test.ts
```

Expected: PASS for English and Chinese.

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/app/[locale]/(marketing) dating-platform/src/app/[locale]/(auth) dating-platform/messages dating-platform/tests/unit/datecn-ui/public-pages.test.tsx
git commit -m "feat: redesign DateCN public experience"
```

### Task 5: Implement discover, matches, and profile demos

**Files:**
- Create: `dating-platform/src/app/[locale]/demo/discover/page.tsx`
- Create: `dating-platform/src/app/[locale]/demo/matches/page.tsx`
- Create: `dating-platform/src/app/[locale]/demo/profile/[profileId]/page.tsx`
- Create: `dating-platform/src/components/datecn/filter-panel.tsx`
- Create: `dating-platform/src/components/datecn/profile-detail.tsx`
- Test: `dating-platform/tests/unit/datecn-ui/discovery-pages.test.tsx`

- [ ] **Step 1: Write failing discovery tests**

```tsx
expect(screen.getAllByTestId("demo-profile-card")).toHaveLength(8);
expect(screen.getByRole("button", {name: "Filters"})).toHaveAttribute("aria-expanded", "false");
expect(screen.getByText("92% compatible")).toBeInTheDocument();
```

Also assert unknown profile IDs render the existing localized not-found boundary rather than a blank page.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/discovery-pages.test.tsx
```

- [ ] **Step 3: Build desktop and mobile discovery states**

Desktop uses a 240px filter sidebar and a three-column grid. Mobile uses one prominent profile card, horizontally scrollable category chips, and an accessible filter drawer. Like/favorite/message buttons show demo-only feedback and never issue network requests.

- [ ] **Step 4: Build matches and profile detail**

Matches show mutual-match timestamps and conversation entry links. Profile detail shows original sprite imagery, verification, bio, interests, relationship goal, and fixed primary actions. All routes use `getDemoProfile`/`getDemoHome` only.

- [ ] **Step 5: Run GREEN**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/discovery-pages.test.tsx tests/unit/demo/demo-service.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/app/[locale]/demo/discover dating-platform/src/app/[locale]/demo/matches dating-platform/src/app/[locale]/demo/profile dating-platform/src/components/datecn dating-platform/tests/unit/datecn-ui/discovery-pages.test.tsx
git commit -m "feat: add DateCN discovery and profile demos"
```

### Task 6: Implement the responsive message experience

**Files:**
- Create: `dating-platform/src/app/[locale]/demo/messages/page.tsx`
- Create: `dating-platform/src/app/[locale]/demo/messages/messages-demo.tsx`
- Test: `dating-platform/tests/unit/datecn-ui/messages-demo.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Assert the first conversation is selected on desktop, selecting a second conversation updates the thread, sending a demo message appends only local component state, and mobile back navigation returns to the conversation list.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/messages-demo.test.tsx
```

- [ ] **Step 3: Implement the three-column desktop layout**

Use a 300px conversation list, flexible message thread, and 260px profile summary. Message compose uses controlled local state; submit trims text and refuses empty content. Add a persistent demo safety notice.

- [ ] **Step 4: Implement mobile split navigation**

Below `md`, show either the list or one thread. Preserve a 44px back button and composer above the safe-area bottom navigation.

- [ ] **Step 5: Run GREEN**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/messages-demo.test.tsx
```

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/app/[locale]/demo/messages dating-platform/tests/unit/datecn-ui/messages-demo.test.tsx
git commit -m "feat: add DateCN message demo"
```

### Task 7: Implement membership center and personal dashboard

**Files:**
- Create: `dating-platform/src/app/[locale]/demo/membership/page.tsx`
- Create: `dating-platform/src/app/[locale]/demo/me/page.tsx`
- Create: `dating-platform/src/components/datecn/plan-card.tsx`
- Create: `dating-platform/src/components/datecn/profile-completion.tsx`
- Test: `dating-platform/tests/unit/datecn-ui/account-pages.test.tsx`

- [ ] **Step 1: Write failing account-page tests**

Assert Free, Plus, and Premium cards render; Premium is visually recommended; upgrade controls carry `data-demo-action` and do not call checkout; personal dashboard shows completion, profile preview, settings, notification, privacy, and membership links.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/account-pages.test.tsx
```

- [ ] **Step 3: Implement membership center**

Render comparison cards from demo data. The upgrade button opens a local demo notice: “Payments are disabled in demo mode.” Do not import the Stripe runtime or call `/api/v1/checkout-sessions`.

- [ ] **Step 4: Implement personal dashboard**

Show the demo user's profile completion, privacy/safety shortcuts, current Free plan, and a profile preview. Settings links may point to existing production pages only when marked “Sign in required”; the primary demo experience remains read-only.

- [ ] **Step 5: Run GREEN**

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/datecn-ui/account-pages.test.tsx
```

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/src/app/[locale]/demo/membership dating-platform/src/app/[locale]/demo/me dating-platform/src/components/datecn dating-platform/tests/unit/datecn-ui/account-pages.test.tsx
git commit -m "feat: add DateCN membership and profile demos"
```

### Task 8: Lock navigation, responsive behavior, and demo isolation

**Files:**
- Create: `dating-platform/tests/contract/datecn-visible-mvp.test.ts`
- Create: `dating-platform/tests/e2e/datecn-visible-mvp.spec.ts`
- Modify: `dating-platform/messages/en.json`
- Modify: `dating-platform/messages/zh-CN.json`

- [ ] **Step 1: Write the route/isolation contract**

The contract reads source files and asserts:

```ts
const requiredRoutes = ["discover", "matches", "messages", "membership", "me"];
for (const route of requiredRoutes) expect(routeSource(route)).toContain("@/modules/demo/demo-service");
expect(allDemoSources).not.toMatch(/DATABASE_URL|STRIPE_SECRET|checkout-sessions|messageRepository|fetch\(/);
expect(catalogKeys("en")).toEqual(catalogKeys("zh-CN"));
```

- [ ] **Step 2: Run contract RED, then fix missing links/keys**

```powershell
.\node_modules\.bin\vitest.cmd run tests/contract/datecn-visible-mvp.test.ts
```

Expected first run: FAIL on any missing route, navigation target, or translation key. Add only the missing links/keys until PASS.

- [ ] **Step 3: Add Playwright viewport checks**

```ts
test("DateCN demo is usable at phone and desktop widths", async ({page}) => {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.goto("/en/demo/discover");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("navigation")).toBeVisible();
  }
});
```

- [ ] **Step 4: Run focused UI suite**

```powershell
.\node_modules\.bin\vitest.cmd run --maxWorkers=1 tests/unit/demo tests/unit/datecn-ui tests/contract/datecn-visible-mvp.test.ts tests/contract/locale-contract.test.ts
```

Expected: all DateCN UI and locale tests pass.

- [ ] **Step 5: Review with React best-practices checklist**

Verify no nested component definitions, no unstable effect dependencies, no unnecessary client components, no missing accessible labels, no raw `<img>` when `next/image` applies, and no request waterfalls in server components.

- [ ] **Step 6: Commit**

```powershell
git add dating-platform/messages dating-platform/tests/contract/datecn-visible-mvp.test.ts dating-platform/tests/e2e/datecn-visible-mvp.spec.ts
git commit -m "test: verify DateCN visible demo"
```

### Task 9: Final local preview and visual handoff

**Files:**
- Verify all visible MVP files.
- Create screenshots in a temporary verification directory only; do not commit generated test screenshots unless explicitly approved.

- [ ] **Step 1: Run static gates**

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --incremental false
.\node_modules\.bin\eslint.cmd .
.\node_modules\.bin\drizzle-kit.cmd check
.\node_modules\.bin\drizzle-kit.cmd generate
git diff --check
```

Expected: all exit 0; Drizzle reports no schema changes.

- [ ] **Step 2: Run the full suite once**

```powershell
.\node_modules\.bin\vitest.cmd run --maxWorkers=1
```

Expected: zero failures; real PostgreSQL tests may only skip when `TEST_DATABASE_URL` is absent.

- [ ] **Step 3: Build production output**

Run `next build` with HTTPS placeholder environment values and no `.env` file. Expected: compilation, TypeScript, page-data collection, and static generation all succeed.

- [ ] **Step 4: Start and inspect the built app**

Start `next start` in a hidden child process. Verify these URLs at desktop and phone widths:

```text
/en
/zh-CN
/en/sign-in
/en/demo/discover
/en/demo/matches
/en/demo/profile/demo-lina
/en/demo/messages
/en/demo/membership
/en/demo/me
```

Expected: HTTP 200, no horizontal overflow, no console errors, all navigation links work.

- [ ] **Step 5: Present the preview**

Give the user one local preview URL plus screenshots for homepage, discovery, messages, membership, and a 360px mobile screen. Do not deploy to `datecn.org` without a separate explicit request.

- [ ] **Step 6: Commit the final UI state**

```powershell
git add dating-platform
git commit -m "feat: add DateCN visible demo experience"
```

