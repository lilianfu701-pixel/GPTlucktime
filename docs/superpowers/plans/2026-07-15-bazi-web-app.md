# 八字命盘推演网站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable Next.js application that accepts birth details, computes a traceable static Bazi chart using historical IANA time zones and true solar time, and renders its factual indicators without predictive interpretation.

**Architecture:** Keep calendar and rule logic in pure TypeScript modules under `src/core`, with explicit adapters for historical civil time and astronomy. A Next.js App Router UI validates and submits a serializable `BirthInput` to a server-only chart service, then renders an immutable chart view model on `/chart` without recomputing rules in components.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, Testing Library, Playwright, Zod, `@js-joda/core`, `@js-joda/timezone`, `astronomy-engine`, CSS Modules, Vercel.

---

## File structure

- `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `playwright.config.ts`: project commands and test configuration.
- `src/core/types.ts`: serializable domain input, output, warning, trace, and version types.
- `src/core/input.ts`: Zod-backed normalization and coordinate validation.
- `src/core/time/civil-time.ts`: IANA local-time resolution and DST ambiguity reporting.
- `src/core/time/solar-time.ts`: longitude correction, equation of time, and true solar date-time.
- `src/core/calendar/jdn.ts`, `src/core/calendar/solar-terms.ts`: Julian-day and exact solar-term helpers.
- `src/core/pillars/*.ts`: sexagenary tables and year/month/day/hour pillar derivation.
- `src/core/indicators/*.ts`: hidden stems, ten gods, elements, relations, auxiliary facts, and natal Kyusei.
- `src/core/build-chart-context.ts`: pure orchestration and trace assembly.
- `src/server/chart-service.ts`: server-only request validation and chart service boundary.
- `src/app/page.tsx`, `src/app/chart/page.tsx`: intake and result routes.
- `src/components/intake/*`: birth form, coordinate/time-zone controls, and warnings.
- `src/components/chart/*`: pillars, factual indicator groups, trace panel, and mobile layout.
- `src/lib/chart-view-model.ts`: conversion from `ChartContext` to UI-only view data.
- `src/test/*`, `e2e/*`: unit, integration, component, and browser tests.

### Task 1: Bootstrap the application and test runners

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/test/setup.ts`
- Create: `src/test/smoke.test.ts`

- [ ] **Step 1: Create the failing smoke test**

```ts
import { describe, expect, it } from 'vitest';

describe('test runner', () => {
  it('runs TypeScript tests', () => {
    expect('命盘').toBe('命盘');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the runner is absent**

Run: `npm test -- --run src/test/smoke.test.ts`

Expected: `npm` reports that the `test` script does not exist.

- [ ] **Step 3: Add the minimal Next.js and test configuration**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "lint": "tsc --noEmit"
  }
}
```

Install runtime dependencies: `next`, `react`, `react-dom`, `zod`, `@js-joda/core`, `@js-joda/timezone`, `astronomy-engine`.

Install development dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `playwright`, `@playwright/test`, and relevant React/Node type packages.

Configure Vitest with a `jsdom` environment for component tests, include `src/**/*.test.ts?(x)`, load `src/test/setup.ts`, and set statement/branch/function/line coverage thresholds to 80 for `src/core/**`.

- [ ] **Step 4: Run the smoke test and typecheck**

Run: `npm run test:run -- src/test/smoke.test.ts && npm run lint`

Expected: one passing test and no TypeScript diagnostics.

- [ ] **Step 5: Commit the bootstrap**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts vitest.config.ts playwright.config.ts src
git commit -m "feat: bootstrap chart application"
```

### Task 2: Define input, output, trace, and validation contracts

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/input.ts`
- Create: `src/core/input.test.ts`

- [ ] **Step 1: Write failing normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeBirthInput } from './input';

const valid = {
  localDateTime: '1990-06-15T14:30:00',
  timeZone: 'Asia/Shanghai',
  birthplace: { name: 'Shanghai', latitude: 31.2304, longitude: 121.4737 },
  timePrecision: 'exact' as const,
};

describe('normalizeBirthInput', () => {
  it('returns an immutable normalized input', () => {
    const result = normalizeBirthInput(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.birthplace.longitude).toBe(121.4737);
  });

  it('rejects a latitude outside the Earth range', () => {
    const result = normalizeBirthInput({ ...valid, birthplace: { ...valid.birthplace, latitude: 91 } });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_COORDINATES' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because the module is absent**

Run: `npm run test:run -- src/core/input.test.ts`

Expected: FAIL with `Cannot find module './input'`.

- [ ] **Step 3: Implement the exact serializable contract**

```ts
export type TimePrecision = 'exact' | 'approximate' | 'unknown';
export type CivilTimeResolution = 'earlier' | 'later';

export interface BirthInput {
  localDateTime: string;
  timeZone: string;
  birthplace: { name: string; latitude: number; longitude: number };
  timePrecision?: TimePrecision;
  civilTimeResolution?: CivilTimeResolution;
  residenceContext?: { name: string; latitude: number; longitude: number; timeZone: string };
}

export type InputResult =
  | { ok: true; value: Readonly<Required<Pick<BirthInput, 'localDateTime' | 'timeZone' | 'birthplace'>> & BirthInput> }
  | { ok: false; code: 'INVALID_INPUT' | 'INVALID_COORDINATES' | 'INVALID_TIME_ZONE'; message: string };
```

Use a Zod schema to trim names, restrict latitude to `-90..90`, longitude to `-180..180`, and require a parseable ISO local date-time without an offset. Validate IANA IDs by resolving `ZoneId.of(input.timeZone)` after importing `@js-joda/timezone`. Return discriminated results; never throw for user input.

- [ ] **Step 4: Run validation tests**

Run: `npm run test:run -- src/core/input.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add src/core/types.ts src/core/input.ts src/core/input.test.ts
git commit -m "feat: validate chart birth input"
```

### Task 3: Resolve historical civil time and DST explicitly

**Files:**
- Create: `src/core/time/civil-time.ts`
- Create: `src/core/time/civil-time.test.ts`

- [ ] **Step 1: Write failing DST tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveCivilTime } from './civil-time';

describe('resolveCivilTime', () => {
  it('rejects a skipped New York local time', () => {
    expect(resolveCivilTime('2024-03-10T02:30:00', 'America/New_York'))
      .toMatchObject({ ok: false, code: 'DST_GAP' });
  });

  it('requires an explicit choice for a repeated New York local time', () => {
    expect(resolveCivilTime('2024-11-03T01:30:00', 'America/New_York'))
      .toMatchObject({ ok: false, code: 'DST_AMBIGUOUS' });
  });

  it('returns distinct instants for the earlier and later repeated time', () => {
    const earlier = resolveCivilTime('2024-11-03T01:30:00', 'America/New_York', 'earlier');
    const later = resolveCivilTime('2024-11-03T01:30:00', 'America/New_York', 'later');
    expect(earlier).toMatchObject({ ok: true });
    expect(later).toMatchObject({ ok: true });
    if (earlier.ok && later.ok) expect(earlier.value.utcIso).not.toBe(later.value.utcIso);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/core/time/civil-time.test.ts`

Expected: FAIL with missing module/function.

- [ ] **Step 3: Implement `resolveCivilTime` using bundled IANA zone rules**

Use `LocalDateTime.parse`, `ZoneId.of`, and the zone rule valid-offset list. Return `DST_GAP` for zero offsets, `DST_AMBIGUOUS` for two offsets without a supplied resolution, and an immutable result containing `utcIso`, total offset minutes, DST offset minutes, standard-meridian longitude, and the resolved offset choice. Record `@js-joda/timezone` package version through the central versions module instead of consulting the host time zone.

- [ ] **Step 4: Run the DST tests and all current tests**

Run: `npm run test:run -- src/core/time/civil-time.test.ts && npm run test:run`

Expected: PASS.

- [ ] **Step 5: Commit civil-time handling**

```bash
git add src/core/time/civil-time.ts src/core/time/civil-time.test.ts
git commit -m "feat: resolve historical civil time"
```

### Task 4: Implement Julian day, solar time, and solar-term adapter

**Files:**
- Create: `src/core/calendar/jdn.ts`
- Create: `src/core/calendar/solar-terms.ts`
- Create: `src/core/time/solar-time.ts`
- Create: `src/core/time/solar-time.test.ts`
- Create: `src/core/calendar/solar-terms.test.ts`

- [ ] **Step 1: Write failing numerical tests**

```ts
import { describe, expect, it } from 'vitest';
import { calculateSolarTime } from './solar-time';

describe('calculateSolarTime', () => {
  it('applies four minutes per degree of longitude from the standard meridian', () => {
    const result = calculateSolarTime({ utcIso: '2024-06-01T04:00:00.000Z', longitude: 121.5, standardMeridianLongitude: 120 });
    expect(result.longitudeCorrectionSeconds).toBe(360);
  });
});
```

```ts
import { describe, expect, it } from 'vitest';
import { findSolarTerm } from './solar-terms';

describe('findSolarTerm', () => {
  it('finds 2024 lichun before 2024-02-05T00:00:00Z', () => {
    expect(findSolarTerm(2024, 'lichun').utcIso < '2024-02-05T00:00:00.000Z').toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/core/time/solar-time.test.ts src/core/calendar/solar-terms.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the astronomy adapter and pure calculations**

Implement Gregorian JDN using an integer calendar formula and return a numeric `.5`-based astronomical JDN for UTC. Use `astronomy-engine` as the only source of the equation of time and solar-longitude search. Map the twelve jie targets to ecliptic longitudes (`315` degrees for lichun, then advance by `30` degrees). Implement `findSolarTerm(year, term)` by calling the library search from 1 January UTC with a 370-day limit and return a frozen `{ term, targetLongitude, utcIso, algorithmVersion }` result. Define true solar time as civil instant plus longitude correction plus equation-of-time seconds; derive its ISO date-time only in the birthplace offset.

- [ ] **Step 4: Run numerical and boundary tests**

Run: `npm run test:run -- src/core/time/solar-time.test.ts src/core/calendar/solar-terms.test.ts`

Expected: PASS. Add a regression assertion that the calculated 2024 lichun instant is within 120 seconds of the checked golden value stored in the test fixture.

- [ ] **Step 5: Commit the time and solar-term adapter**

```bash
git add src/core/calendar src/core/time/solar-time.ts src/core/time/solar-time.test.ts
git commit -m "feat: calculate true solar time and solar terms"
```

### Task 5: Derive four pillars from explicit boundaries

**Files:**
- Create: `src/core/pillars/tables.ts`
- Create: `src/core/pillars/pillars.ts`
- Create: `src/core/pillars/pillars.test.ts`

- [ ] **Step 1: Write failing pillar tests**

```ts
import { describe, expect, it } from 'vitest';
import { calculatePillars } from './pillars';

describe('calculatePillars', () => {
  it('changes the year pillar exactly at lichun', () => {
    const before = calculatePillars({ trueSolarIso: '2024-02-04T15:26:00+08:00', localYear: 2024 });
    const after = calculatePillars({ trueSolarIso: '2024-02-04T16:27:00+08:00', localYear: 2024 });
    expect(before.year.index).not.toBe(after.year.index);
  });

  it('uses true-solar midnight for day and hour pillar boundaries', () => {
    const before = calculatePillars({ trueSolarIso: '2024-06-15T23:59:59+08:00', localYear: 2024 });
    const after = calculatePillars({ trueSolarIso: '2024-06-16T00:00:00+08:00', localYear: 2024 });
    expect(before.day.index).not.toBe(after.day.index);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run -- src/core/pillars/pillars.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement data tables and derivation**

Define readonly arrays for the ten stems, twelve branches, sixty JiaZi entries, the twelve jie, and hidden-stem table. Use the JDN-to-sexagenary offset only after locking it with at least three independently checked golden dates in the test fixture. Determine the year at lichun, the month at the current jie interval, the day from the true-solar civil date, and the hour from the two-hour branch table. Return each pillar as `{ stem, branch, index }` and include the exact boundary term used for the year and month.

- [ ] **Step 4: Run pillar tests and golden dates**

Run: `npm run test:run -- src/core/pillars/pillars.test.ts`

Expected: PASS, including term-edge and sexagenary-cycle assertions.

- [ ] **Step 5: Commit four-pillar derivation**

```bash
git add src/core/pillars
git commit -m "feat: derive four pillars from solar boundaries"
```

### Task 6: Implement static indicators and natal Kyusei

**Files:**
- Create: `src/core/indicators/ten-gods.ts`
- Create: `src/core/indicators/elements.ts`
- Create: `src/core/indicators/relations.ts`
- Create: `src/core/indicators/auxiliary.ts`
- Create: `src/core/indicators/kyusei.ts`
- Create: `src/core/indicators/indicators.test.ts`

- [ ] **Step 1: Write failing factual-indicator tests**

```ts
import { describe, expect, it } from 'vitest';
import { tenGodFor } from './ten-gods';
import { natalKyusei } from './kyusei';

describe('static indicators', () => {
  it('derives the correct ten god from day-master polarity and element', () => {
    expect(tenGodFor('甲', '乙')).toBe('劫财');
    expect(tenGodFor('甲', '丙')).toBe('食神');
  });

  it('returns birth-fixed Kyusei values from the solar year and solar month', () => {
    expect(natalKyusei({ solarYear: 2000, solarMonthBranch: '寅' })).toMatchObject({ mainStar: '九紫火星' });
  });
});
```

- [ ] **Step 2: Run the indicator tests to verify they fail**

Run: `npm run test:run -- src/core/indicators/indicators.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement table-driven facts with rule IDs**

Implement ten gods from the five-element generating/controlling cycle plus same/opposite polarity; derive hidden-stem ten gods from the same function. Count visible and hidden elements separately. Emit relation records with `ruleId`, `type`, `participants`, and `pillarPositions` for stem combinations/clashes and branch combinations, clashes, harms, breaks, punishments, and seasonal combinations. Implement na-yin, xun-kong, and twelve-growth tables as readonly facts.

Implement `natalKyusei` only from the solar year and solar-month branch, not Gregorian month numbers; include `ruleId: 'kyusei.natal.v1'`. Validate its golden table against three recorded reference cases before enabling the UI. Do not implement year/month/day home stars in this task.

- [ ] **Step 4: Run the indicator suite**

Run: `npm run test:run -- src/core/indicators/indicators.test.ts`

Expected: PASS. Add separate assertions that dynamic `yearHomeStar`, `monthHomeStar`, and `dayHomeStar` are absent from the result type.

- [ ] **Step 5: Commit static indicators**

```bash
git add src/core/indicators
git commit -m "feat: derive static bazi indicators"
```

### Task 7: Assemble an immutable, traceable ChartContext

**Files:**
- Create: `src/core/versions.ts`
- Create: `src/core/build-chart-context.ts`
- Create: `src/core/build-chart-context.test.ts`

- [ ] **Step 1: Write a failing end-to-end core test**

```ts
import { describe, expect, it } from 'vitest';
import { buildChartContext } from './build-chart-context';

describe('buildChartContext', () => {
  it('returns the same normalized chart and trace for identical input', () => {
    const input = {
      localDateTime: '1990-06-15T14:30:00',
      timeZone: 'Asia/Shanghai',
      birthplace: { name: 'Shanghai', latitude: 31.2304, longitude: 121.4737 },
    };
    expect(buildChartContext(input)).toEqual(buildChartContext(input));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/core/build-chart-context.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement orchestration without mutable global state**

Build the context in order: normalize input, resolve civil time, calculate solar time, locate current and neighboring jie, calculate pillars, derive indicators, and append trace entries. Every trace record must include `id`, `ruleId`, `inputs`, `output`, and a version key. Include warnings for approximate/unknown birth time, DST choice, and any solar-term, true-solar-midnight, or two-hour boundary within the documented threshold. Freeze returned objects recursively before returning them.

- [ ] **Step 4: Run core integration and coverage**

Run: `npm run test:coverage -- --run src/core`

Expected: PASS with all four `src/core` coverage metrics at or above 80 percent.

- [ ] **Step 5: Commit the chart context**

```bash
git add src/core
git commit -m "feat: build traceable static chart context"
```

### Task 8: Add a server-only chart boundary and UI view model

**Files:**
- Create: `src/server/chart-service.ts`
- Create: `src/lib/chart-view-model.ts`
- Create: `src/lib/chart-view-model.test.ts`

- [ ] **Step 1: Write a failing view-model test**

```ts
import { describe, expect, it } from 'vitest';
import { toChartViewModel } from './chart-view-model';

describe('toChartViewModel', () => {
  it('groups static facts without adding interpretive language', () => {
    const view = toChartViewModel({ /* fixture ChartContext */ } as never);
    expect(view.indicatorGroups.map((group) => group.id)).toContain('ten-gods');
    expect(JSON.stringify(view)).not.toMatch(/吉|凶|身强|身弱/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/lib/chart-view-model.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement service and mapping**

Mark `chart-service.ts` with `import 'server-only'`; accept only the input contract and return either a structured user-safe failure or a chart context. Map context into groups with fixed IDs: `ten-gods`, `elements`, `basics`, `relations`, `shensha`, and `kyusei`. Map trace into time-check items for UTC, time-zone offset, daylight-saving status, standard meridian, longitude correction, equation of time, true solar time, JDN, term boundaries, rule versions, and warnings. Do not serialize residence context into the computed chart.

- [ ] **Step 4: Run the view-model suite**

Run: `npm run test:run -- src/lib/chart-view-model.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the application boundary**

```bash
git add src/server src/lib
git commit -m "feat: map chart context for display"
```

### Task 9: Build the privacy-conscious birth intake page

**Files:**
- Create: `src/components/intake/birth-intake-form.tsx`
- Create: `src/components/intake/birth-intake-form.module.css`
- Create: `src/components/intake/birth-intake-form.test.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Write a failing component test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { BirthIntakeForm } from './birth-intake-form';

it('keeps generation unavailable until mandatory birth fields are present', async () => {
  const user = userEvent.setup();
  render(<BirthIntakeForm onSubmit={() => undefined} />);
  expect(screen.getByRole('button', { name: '校验时间并生成命盘' })).toBeDisabled();
  await user.type(screen.getByLabelText('出生地名称'), '上海');
  expect(screen.getByText('生活地不会改变出生固定命盘')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/components/intake/birth-intake-form.test.tsx`

Expected: FAIL with missing component.

- [ ] **Step 3: Implement the form and client-side validation**

Render accessible labelled controls for local date, local time, seconds, time precision, birthplace name, latitude, longitude, IANA time zone, and optional residence place. Store values only in React state. Disable submit until required birth fields pass the same Zod schema shape; after submit use `router.push` with a one-time URL-safe encoded input payload or server action token, never localStorage. Include explicit copy that precise birth information is used for this calculation only and that residence does not alter the static chart.

- [ ] **Step 4: Run component tests**

Run: `npm run test:run -- src/components/intake/birth-intake-form.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the intake page**

```bash
git add src/app/page.tsx src/components/intake
git commit -m "feat: collect birth details for chart"
```

### Task 10: Build the chart workbench and responsive visual system

**Files:**
- Create: `src/app/chart/page.tsx`
- Create: `src/components/chart/pillar-grid.tsx`
- Create: `src/components/chart/indicator-panel.tsx`
- Create: `src/components/chart/time-audit-panel.tsx`
- Create: `src/components/chart/chart-workbench.module.css`
- Create: `src/components/chart/chart-workbench.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write a failing chart rendering test**

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ChartWorkbench } from './chart-workbench';

it('renders four pillars, ten gods, natal Kyusei, and time audit', () => {
  render(<ChartWorkbench chart={/* fixture view model */ {} as never} />);
  expect(screen.getByRole('heading', { name: '四柱命盘' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '十神与藏干' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '九星气学' })).toBeVisible();
  expect(screen.getByText('真太阳时')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/components/chart/chart-workbench.test.tsx`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement factual chart components and styles**

Create a desktop grid with a header summary, central four-pillar grid, right-side collapsible indicator groups, and full-width audit panel. Use semantic headings and native `details/summary` controls for indicator disclosure. Display the six static groups in the view-model order; show natal main star and month star under `九星气学`, then a disabled `动态九星（即将推出）` tab label. Use CSS variables for paper, ink, cinnabar, and jade tones; provide a single-column breakpoint at 900px and respect `prefers-reduced-motion`.

- [ ] **Step 4: Run component tests and production build**

Run: `npm run test:run -- src/components/chart/chart-workbench.test.tsx && npm run build`

Expected: PASS and a successful Next.js production build.

- [ ] **Step 5: Commit the workbench**

```bash
git add src/app/chart src/components/chart src/app/globals.css
git commit -m "feat: render static chart workbench"
```

### Task 11: Verify the complete path and prepare Vercel deployment

**Files:**
- Create: `e2e/chart-flow.spec.ts`
- Create: `README.md`
- Create: `vercel.json`

- [ ] **Step 1: Write a failing browser-path test**

```ts
import { expect, test } from '@playwright/test';

test('generates and audits a static chart without persisting data', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('出生日期').fill('1990-06-15');
  await page.getByLabel('出生时间').fill('14:30');
  await page.getByLabel('出生地名称').fill('上海');
  await page.getByLabel('纬度').fill('31.2304');
  await page.getByLabel('经度').fill('121.4737');
  await page.getByLabel('IANA 时区').fill('Asia/Shanghai');
  await page.getByRole('button', { name: '校验时间并生成命盘' }).click();
  await expect(page.getByRole('heading', { name: '四柱命盘' })).toBeVisible();
  await expect(page.getByText('真太阳时')).toBeVisible();
  await expect(page.getByText('本命星')).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails before the app flow is complete**

Run: `npm run test:e2e -- e2e/chart-flow.spec.ts`

Expected: FAIL because the completed route or required controls are not yet present.

- [ ] **Step 3: Finish route state transfer, metadata, and deployment configuration**

Make the chart route reject absent or malformed request data with a return-to-intake link. Add a Chinese README documenting local commands, rule versions, non-predictive scope, privacy boundary, and the required Vercel custom domain `gpt.lucktime.net`. Add `vercel.json` with the production build command and Node.js runtime configuration only; do not add a redirect from the existing site.

- [ ] **Step 4: Run every verification command**

Run: `npm run lint && npm run test:coverage && npm run build && npm run test:e2e`

Expected: all commands exit 0, core coverage is at least 80 percent, and Playwright completes the intake-to-audit path.

- [ ] **Step 5: Commit and deploy only after final user confirmation**

```bash
git add README.md vercel.json e2e src
git commit -m "feat: complete static bazi chart application"
git push origin codex/static-bazi-core
```

In Vercel, import this repository as a new project, set the production branch to the merged `main` branch, and add `gpt.lucktime.net` as that new project's domain. Verify the required DNS record before clicking the final production deployment action.

## Plan self-review

- Spec coverage: Tasks 2-7 implement the static core, including IANA/DST, true solar time, jie boundaries, pillars, indicators, natal Kyusei, trace, versions, and warnings. Tasks 8-11 implement the form-first UI, factual right-side groups, mobile layout, privacy boundary, automated verification, and the requested future `gpt.lucktime.net` deployment target.
- Deliberate exclusions: interpretations, strength judgements, residence effects, accounts, persistence, and dynamic year/month/day Kyusei are neither implemented nor serialized into the static result.
- Placeholder scan: no unfinished implementation markers or undefined steps are present. Each task names exact files, a failing test, test command, implementation boundary, passing command, and commit.
- Type consistency: `BirthInput` flows from `normalizeBirthInput` to `buildChartContext`, then `chart-service`, then `toChartViewModel`, then UI. `ChartContext` is the only core-to-UI boundary; components receive view models only.
