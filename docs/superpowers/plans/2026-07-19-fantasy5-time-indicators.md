# Fantasy 5 Time Indicator Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic TypeScript engine that reads the California Fantasy 5 history CSV, resolves every draw at `18:25:00 America/Los_Angeles`, calculates the agreed 118-field time snapshot, and exports an auditable enriched CSV without using future draw results.

**Architecture:** Keep time resolution, astronomy, Chinese-calendar rules, traditional tables, orchestration, and CSV I/O in separate pure modules. Third-party libraries sit behind narrow adapters, every rule bundle has a version, and golden fixtures lock boundary behavior before the full 11,860-row history is generated. This plan covers only the time-indicator engine and enriched dataset; probability modeling and the web interface receive separate plans after this output passes review.

**Tech Stack:** Node.js 24, TypeScript 5, pnpm 11, Vitest, Zod, `@js-joda/core`, `@js-joda/timezone`, `astronomy-engine`, `lunar-typescript`, `csv-parse`, `csv-stringify`.

---

## Scope and file map

- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`: runtime, scripts, strict compilation, and tests.
- `src/fantasy5/domain/types.ts`: draw input, snapshot groups, audit metadata, and result types.
- `src/fantasy5/domain/indicator-dictionary.ts`: the canonical ordered list of 118 indicator keys and eight metadata keys.
- `src/fantasy5/domain/versions.ts`: immutable algorithm and dependency versions.
- `src/fantasy5/time/resolve-draw-moment.ts`: resolve a draw date at 18:25 in Los Angeles using IANA rules.
- `src/fantasy5/calendar/civil-calendar.ts`: 15 civil-calendar values and Julian-day helpers.
- `src/fantasy5/calendar/lunar-calendar.ts`: six lunar values behind a narrow adapter.
- `src/fantasy5/astronomy/solar-terms.ts`: exact adjacent solar terms and 12 term fields.
- `src/fantasy5/astronomy/sun-moon.ts`: ten astronomical fields.
- `src/fantasy5/traditional/tables.ts`: readonly stems, branches, elements, hidden stems, ten gods, growth stages, nayin, mansions, and nine-star tables.
- `src/fantasy5/traditional/pillars.ts`: the 28 pillar fields with explicit year/month/day/hour boundaries.
- `src/fantasy5/traditional/auxiliary.ts`: 18 auxiliary fields, four growth stages, five day-officer fields, and four mansion fields.
- `src/fantasy5/traditional/nine-stars.ts`: eight year/month/day/hour nine-star fields.
- `src/fantasy5/traditional/qimen-summary.ts`: eight deterministic, versioned split-complement rotating-chart summary fields, marked experimental until golden fixtures pass.
- `src/fantasy5/build-time-snapshot.ts`: assemble and freeze the complete 118-field snapshot.
- `src/fantasy5/io/history-csv.ts`: validate and stream the source CSV.
- `src/fantasy5/io/enrich-history.ts`: append flat metadata and indicator columns in canonical order.
- `src/fantasy5/cli/enrich-fantasy5.ts`: CLI entry point with explicit input/output arguments.
- `src/fantasy5/test/fixtures/*.json`: independently checked boundary and golden cases.
- `data/derived/.gitkeep`: output directory marker; generated CSV files remain ignored.
- `README.md`: local commands, source assumptions, rule versions, and limitations.

### Task 1: Bootstrap the TypeScript indicator package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/fantasy5/test/setup.ts`
- Create: `src/fantasy5/test/smoke.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing smoke test**

```ts
// src/fantasy5/test/smoke.test.ts
import { describe, expect, it } from 'vitest';

describe('fantasy5 indicator test runner', () => {
  it('runs strict TypeScript tests', () => {
    expect({ time: '18:25:00', zone: 'America/Los_Angeles' }).toEqual({
      time: '18:25:00',
      zone: 'America/Los_Angeles',
    });
  });
});
```

- [ ] **Step 2: Run the test before configuration exists**

Run: `corepack pnpm test -- --run src/fantasy5/test/smoke.test.ts`

Expected: FAIL because `package.json` and the `test` script do not exist.

- [ ] **Step 3: Add pinned runtime and test configuration**

```json
{
  "name": "lucktime-fantasy5",
  "private": true,
  "packageManager": "pnpm@11.3.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "build": "tsc -p tsconfig.json",
    "fantasy5:enrich": "tsx src/fantasy5/cli/enrich-fantasy5.ts"
  },
  "dependencies": {
    "@js-joda/core": "5.6.5",
    "@js-joda/timezone": "2.25.1",
    "astronomy-engine": "2.1.19",
    "csv-parse": "6.1.0",
    "csv-stringify": "6.6.0",
    "lunar-typescript": "1.8.6",
    "zod": "4.1.12"
  },
  "devDependencies": {
    "@types/node": "24.10.0",
    "@vitest/coverage-v8": "4.0.7",
    "tsx": "4.20.6",
    "typescript": "5.9.3",
    "vitest": "4.0.7"
  }
}
```

Use `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and include only `src/**/*.ts`. Configure Vitest for the Node environment and `src/**/*.test.ts`.

Append these generated files to `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
data/derived/*.csv
data/derived/*.json
```

- [ ] **Step 4: Install and verify the bootstrap**

Run: `corepack pnpm install`

Expected: `pnpm-lock.yaml` is created with no peer-dependency failure.

Run: `corepack pnpm test:run -- src/fantasy5/test/smoke.test.ts && corepack pnpm typecheck`

Expected: one passing test and zero TypeScript diagnostics.

- [ ] **Step 5: Commit the bootstrap**

```powershell
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/fantasy5/test
git commit -m "feat: bootstrap fantasy 5 indicator engine"
```

### Task 2: Lock the 118-field domain contract and dictionary

**Files:**
- Create: `src/fantasy5/domain/types.ts`
- Create: `src/fantasy5/domain/indicator-dictionary.ts`
- Create: `src/fantasy5/domain/versions.ts`
- Create: `src/fantasy5/domain/indicator-dictionary.test.ts`

- [ ] **Step 1: Write failing cardinality and uniqueness tests**

```ts
import { describe, expect, it } from 'vitest';
import { AUDIT_KEYS, INDICATOR_KEYS } from './indicator-dictionary.js';

describe('indicator dictionary', () => {
  it('locks the accepted field counts', () => {
    expect(INDICATOR_KEYS).toHaveLength(118);
    expect(AUDIT_KEYS).toHaveLength(8);
  });

  it('contains no duplicate names and keeps audit fields separate', () => {
    expect(new Set(INDICATOR_KEYS).size).toBe(118);
    expect(new Set(AUDIT_KEYS).size).toBe(8);
    expect(INDICATOR_KEYS.filter((key) => AUDIT_KEYS.includes(key as never))).toEqual([]);
  });

  it('keeps the requested user-facing filters', () => {
    expect(INDICATOR_KEYS).toEqual(expect.arrayContaining([
      'day_tail', 'weekday_index', 'day_stem_index_10', 'day_branch_index_12',
      'day_stem_element', 'hour_stem_element', 'current_term_index',
    ]));
  });
});
```

- [ ] **Step 2: Run the tests and observe the missing module failure**

Run: `corepack pnpm test:run -- src/fantasy5/domain/indicator-dictionary.test.ts`

Expected: FAIL with `Cannot find module './indicator-dictionary.js'`.

- [ ] **Step 3: Define exact serializable contracts**

```ts
// src/fantasy5/domain/types.ts
export type Element = 'wood' | 'fire' | 'earth' | 'metal' | 'water';
export type YinYang = 'yin' | 'yang';
export type IndicatorScalar = string | number | boolean;

export interface SourceDraw {
  readonly drawDate: string;
  readonly weekday: string;
  readonly numbers: readonly [number, number, number, number, number];
  readonly jackpotText: string;
  readonly jackpotAmount: number | null;
  readonly ruleVersion: string;
  readonly sourceUrl: string;
}

export interface AuditMetadata {
  readonly draw_date: string;
  readonly nominal_local_time: '18:25:00';
  readonly timezone_id: 'America/Los_Angeles';
  readonly time_basis: 'user_selected_nominal_anchor';
  readonly time_precision: 'nominal_minute';
  readonly location_used: false;
  readonly algorithm_bundle_version: string;
  readonly computed_at_utc: string;
}

export type FlatIndicators = Readonly<Record<string, IndicatorScalar>>;

export interface TimeSnapshot {
  readonly audit: AuditMetadata;
  readonly indicators: FlatIndicators;
}
```

Implement `INDICATOR_KEYS` in the exact group order from the accepted design: 15 civil, 6 lunar, 12 solar-term, 10 astronomy, 28 pillar, 18 auxiliary, 4 growth-stage, 5 day-officer, 4 mansion, 8 nine-star, and 8 Qimen keys. Use explicit string literals, not generated placeholder names. Export `INDICATOR_GROUP_COUNTS` and assert that its sum is 118 at module initialization.

```ts
// src/fantasy5/domain/versions.ts
export const VERSIONS = Object.freeze({
  bundle: 'fantasy5-time-snapshot-v1',
  anchor: 'la-1825-iana-v1',
  civil: 'gregorian-iso-jdn-v1',
  astronomy: 'astronomy-engine-2.1.19',
  lunar: 'lunar-typescript-1.8.6-adapter-v1',
  pillars: 'lichun-jie-midnight-v1',
  traditional: 'table-bundle-v1',
  nineStar: 'lunar-typescript-1.8.6-adapter-v1',
  qimen: 'split-complement-rotating-v1-experimental',
} as const);
```

- [ ] **Step 4: Run dictionary tests and typecheck**

Run: `corepack pnpm test:run -- src/fantasy5/domain/indicator-dictionary.test.ts && corepack pnpm typecheck`

Expected: three passing tests and no diagnostics.

- [ ] **Step 5: Commit the locked contract**

```powershell
git add src/fantasy5/domain
git commit -m "feat: lock fantasy 5 indicator contract"
```

### Task 3: Parse and validate the source history without loading future data

**Files:**
- Create: `src/fantasy5/io/history-csv.ts`
- Create: `src/fantasy5/io/history-csv.test.ts`
- Create: `src/fantasy5/test/fixtures/history-small.csv`

- [ ] **Step 1: Add a three-row fixture and failing parser tests**

```csv
draw_date,weekday,number_1,number_2,number_3,number_4,number_5,jackpot_text,jackpot_amount,rule_version,source_url
1992-02-04,Tuesday,5,8,10,30,38,To Be Calculated,,FANTASY5_5_OF_39,https://example.test/1992
2026-07-17,Friday,3,27,31,32,36,$182000,182000,FANTASY5_5_OF_39,https://example.test/2026
2026-07-18,Saturday,2,9,14,24,39,$80000,80000,FANTASY5_5_OF_39,https://example.test/2026
```

```ts
import { describe, expect, it } from 'vitest';
import { readHistoryCsv } from './history-csv.js';

describe('readHistoryCsv', () => {
  it('parses, sorts, and normalizes source rows', async () => {
    const rows = await readHistoryCsv('src/fantasy5/test/fixtures/history-small.csv');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ drawDate: '1992-02-04', numbers: [5, 8, 10, 30, 38] });
    expect(rows[1]?.jackpotAmount).toBe(182000);
  });

  it('rejects duplicate numbers in one draw', async () => {
    await expect(readHistoryCsv('src/fantasy5/test/fixtures/history-invalid.csv'))
      .rejects.toThrow(/five distinct integers from 1 to 39/);
  });
});
```

- [ ] **Step 2: Run the parser tests and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/io/history-csv.test.ts`

Expected: FAIL because `readHistoryCsv` does not exist.

- [ ] **Step 3: Implement strict header and row validation**

Use `csv-parse/sync` for the 1.4 MB source file. Define a Zod row schema with `YYYY-MM-DD`, five coerced integers, distinctness, `1..39` range, nullable jackpot amount, and URL validation. Sort ascending and reject duplicate `draw_date` values.

```ts
export async function readHistoryCsv(path: string): Promise<readonly SourceDraw[]> {
  const text = await readFile(path, 'utf8');
  const raw = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  const rows = raw.map((row, index) => parseSourceRow(row, index + 2));
  rows.sort((a, b) => a.drawDate.localeCompare(b.drawDate));
  assertUniqueDrawDates(rows);
  return Object.freeze(rows.map(Object.freeze));
}
```

- [ ] **Step 4: Run parser tests**

Run: `corepack pnpm test:run -- src/fantasy5/io/history-csv.test.ts`

Expected: both valid and invalid fixture tests pass.

- [ ] **Step 5: Commit source ingestion**

```powershell
git add src/fantasy5/io src/fantasy5/test/fixtures
git commit -m "feat: validate fantasy 5 history csv"
```

### Task 4: Resolve every draw at 18:25 Los Angeles time

**Files:**
- Create: `src/fantasy5/time/resolve-draw-moment.ts`
- Create: `src/fantasy5/time/resolve-draw-moment.test.ts`

- [ ] **Step 1: Write winter, summer, and determinism tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveDrawMoment } from './resolve-draw-moment.js';

describe('resolveDrawMoment', () => {
  it('uses PST in winter', () => {
    expect(resolveDrawMoment('2026-01-15')).toMatchObject({
      localIso: '2026-01-15T18:25:00-08:00[America/Los_Angeles]',
      utcIso: '2026-01-16T02:25:00Z',
      utcOffsetMinutes: -480,
      isDst: false,
    });
  });

  it('uses PDT in summer', () => {
    expect(resolveDrawMoment('2026-07-15')).toMatchObject({
      utcIso: '2026-07-16T01:25:00Z',
      utcOffsetMinutes: -420,
      isDst: true,
    });
  });

  it('returns equal values for repeated calls', () => {
    expect(resolveDrawMoment('1992-02-04')).toEqual(resolveDrawMoment('1992-02-04'));
  });
});
```

- [ ] **Step 2: Verify the missing implementation failure**

Run: `corepack pnpm test:run -- src/fantasy5/time/resolve-draw-moment.test.ts`

Expected: FAIL with a missing module.

- [ ] **Step 3: Implement the IANA-backed resolver**

```ts
import { LocalDateTime, ZoneId, ZoneOffset } from '@js-joda/core';
import '@js-joda/timezone';

const DRAW_TIME = '18:25:00';
const DRAW_ZONE = ZoneId.of('America/Los_Angeles');

export function resolveDrawMoment(drawDate: string): DrawMoment {
  const local = LocalDateTime.parse(`${drawDate}T${DRAW_TIME}`);
  const zoned = local.atZone(DRAW_ZONE);
  const offset = zoned.offset().totalSeconds() / 60;
  const standardOffset = DRAW_ZONE.rules().standardOffset(zoned.toInstant()).totalSeconds() / 60;
  return Object.freeze({
    drawDate,
    localIso: zoned.toString(),
    utcIso: zoned.withZoneSameInstant(ZoneOffset.UTC).toLocalDateTime().toString() + 'Z',
    epochMilliseconds: zoned.toInstant().toEpochMilli(),
    utcOffsetMinutes: offset,
    isDst: offset !== standardOffset,
  });
}
```

- [ ] **Step 4: Run time-zone tests and typecheck**

Run: `corepack pnpm test:run -- src/fantasy5/time/resolve-draw-moment.test.ts && corepack pnpm typecheck`

Expected: three passing tests; winter is `-480`, summer is `-420`.

- [ ] **Step 5: Commit the anchor resolver**

```powershell
git add src/fantasy5/time
git commit -m "feat: resolve fantasy 5 draw anchor"
```

### Task 5: Calculate civil-calendar and Julian fields

**Files:**
- Create: `src/fantasy5/calendar/civil-calendar.ts`
- Create: `src/fantasy5/calendar/civil-calendar.test.ts`

- [ ] **Step 1: Write failing calendar and J2000 tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildCivilCalendar, julianDay } from './civil-calendar.js';

describe('civil calendar', () => {
  it('calculates a zero date tail and leap-year ordinal', () => {
    expect(buildCivilCalendar(resolveDrawMoment('2024-02-20'))).toMatchObject({
      gregorian_month: 2,
      gregorian_day: 20,
      day_tail: 0,
      day_of_year: 51,
      quarter: 1,
      days_in_month: 29,
    });
  });

  it('locks the J2000 Julian day', () => {
    expect(julianDay(Date.parse('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 8);
  });
});
```

- [ ] **Step 2: Run and observe the missing function failure**

Run: `corepack pnpm test:run -- src/fantasy5/calendar/civil-calendar.test.ts`

Expected: FAIL because the calendar module is absent.

- [ ] **Step 3: Implement the 15 fields with explicit formulas**

Use js-joda `LocalDate`, `IsoFields.WEEK_OF_WEEK_BASED_YEAR`, and arithmetic helpers. Define:

```ts
export const julianDay = (epochMilliseconds: number): number =>
  epochMilliseconds / 86_400_000 + 2_440_587.5;

export const julianDayNumber = (jd: number): number => Math.floor(jd + 0.5);
export const modifiedJulianDay = (jd: number): number => jd - 2_400_000.5;
```

`week_of_month` is `Math.floor((gregorian_day - 1) / 7) + 1`; `day_tail` is `gregorian_day % 10`. Return exactly the 15 dictionary keys in section 4.1 of the design.

- [ ] **Step 4: Run calendar tests**

Run: `corepack pnpm test:run -- src/fantasy5/calendar/civil-calendar.test.ts`

Expected: both tests pass.

- [ ] **Step 5: Commit civil calculations**

```powershell
git add src/fantasy5/calendar/civil-calendar.ts src/fantasy5/calendar/civil-calendar.test.ts
git commit -m "feat: calculate civil and julian indicators"
```

### Task 6: Add lunar-calendar fields behind a stable adapter

**Files:**
- Create: `src/fantasy5/calendar/lunar-calendar.ts`
- Create: `src/fantasy5/calendar/lunar-calendar.test.ts`

- [ ] **Step 1: Write documented golden-date tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildLunarCalendar } from './lunar-calendar.js';

describe('lunar calendar adapter', () => {
  it('matches the library documentation golden date', () => {
    expect(buildLunarCalendar({ year: 1986, month: 5, day: 29, hour: 18, minute: 25, second: 0 }))
      .toMatchObject({ lunar_year: 1986, lunar_month: 4, lunar_day: 21, is_leap_month: false });
  });

  it('keeps progress in the half-open unit interval', () => {
    const result = buildLunarCalendar({ year: 2026, month: 7, day: 19, hour: 18, minute: 25, second: 0 });
    expect(result.lunar_day_progress).toBeGreaterThanOrEqual(0);
    expect(result.lunar_day_progress).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/calendar/lunar-calendar.test.ts`

Expected: FAIL with a missing adapter.

- [ ] **Step 3: Implement the six-field adapter without native `Date`**

```ts
import { Solar } from 'lunar-typescript';

export function buildLunarCalendar(parts: LocalDateTimeParts): LunarIndicators {
  const solar = Solar.fromYmdHms(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  const lunar = solar.getLunar();
  const lunarMonth = lunar.getMonth();
  const monthDays = lunar.getYearObject().getMonth(lunarMonth)?.getDayCount();
  if (!monthDays) throw new Error(`Missing lunar month metadata for ${solar.toYmdHms()}`);
  return Object.freeze({
    lunar_year: lunar.getYear(),
    lunar_month: Math.abs(lunarMonth),
    lunar_day: lunar.getDay(),
    is_leap_month: lunarMonth < 0,
    lunar_month_days: monthDays,
    lunar_day_progress: (lunar.getDay() - 1) / monthDays,
  });
}
```

- [ ] **Step 4: Run adapter tests**

Run: `corepack pnpm test:run -- src/fantasy5/calendar/lunar-calendar.test.ts`

Expected: both tests pass; no code path depends on the host time zone.

- [ ] **Step 5: Commit the lunar adapter**

```powershell
git add src/fantasy5/calendar/lunar-calendar.ts src/fantasy5/calendar/lunar-calendar.test.ts
git commit -m "feat: calculate lunar date indicators"
```

### Task 7: Calculate exact solar terms and Sun/Moon fields

**Files:**
- Create: `src/fantasy5/astronomy/solar-terms.ts`
- Create: `src/fantasy5/astronomy/sun-moon.ts`
- Create: `src/fantasy5/astronomy/astronomy.test.ts`
- Create: `src/fantasy5/test/fixtures/solar-term-golden.json`

- [ ] **Step 1: Add golden fixtures and failing numerical tests**

```json
[
  { "term": "立春", "longitude": 315, "utc": "2024-02-04T08:26:53.000Z", "toleranceSeconds": 120 },
  { "term": "春分", "longitude": 0, "utc": "2024-03-20T03:06:00.000Z", "toleranceSeconds": 120 }
]
```

```ts
import { describe, expect, it } from 'vitest';
import { findSolarTermBracket } from './solar-terms.js';
import { buildSunMoon } from './sun-moon.js';

describe('astronomy indicators', () => {
  it('finds 2024 Lichun within two minutes', () => {
    const bracket = findSolarTermBracket(new Date('2024-02-04T09:00:00Z'));
    expect(bracket.previous.name).toBe('立春');
    expect(Math.abs(Date.parse(bracket.previous.utc) - Date.parse('2024-02-04T08:26:53Z'))).toBeLessThanOrEqual(120_000);
  });

  it('returns bounded Moon values', () => {
    const values = buildSunMoon(new Date('2024-04-08T18:21:00Z'));
    expect(values.lunar_elongation_deg).toBeGreaterThanOrEqual(0);
    expect(values.lunar_elongation_deg).toBeLessThan(360);
    expect(values.moon_illumination_fraction).toBeLessThan(0.01);
    expect(values.moon_distance_km).toBeGreaterThan(300_000);
  });
});
```

- [ ] **Step 2: Run the astronomy tests and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/astronomy/astronomy.test.ts`

Expected: FAIL because both astronomy modules are missing.

- [ ] **Step 3: Implement solar-term search**

Define the 24 term longitudes in order, starting with 春分 at 0 degrees and advancing 15 degrees. For the target instant, search each candidate longitude in a 40-day window around the approximate term and select the nearest previous and next exact instants using `SearchSunLongitude`.

```ts
const found = SearchSunLongitude(targetLongitude, windowStart, 40);
if (!found) throw new Error(`Solar term ${name} not found in search window`);
```

Return all 12 fields, with `term_progress = elapsed / (elapsed + remaining)` and `is_term_local_day` determined after converting each term instant to `America/Los_Angeles`.

- [ ] **Step 4: Implement ten Sun/Moon fields**

Use `EclipticGeoMoon(date)` for lunar longitude/latitude/distance, `MoonPhase(date)` for elongation, `Illumination(Body.Moon, date).phase_fraction` for the illuminated fraction, and `PairLongitude`/`GeoVector` conversion for the Sun's apparent geocentric longitude. If the library's public API lacks a direct geocentric Sun longitude, derive it as `(Earth heliocentric longitude + 180) mod 360` and lock that choice in `VERSIONS.astronomy`.

```ts
const phase = MoonPhase(date);
const moon = EclipticGeoMoon(date);
return Object.freeze({
  solar_longitude_deg: normalizeDegrees(solarLongitude),
  moon_longitude_deg: normalizeDegrees(moon.lon),
  moon_latitude_deg: moon.lat,
  lunar_elongation_deg: phase,
  lunar_phase_progress: phase / 360,
  moon_illumination_fraction: Illumination(Body.Moon, date).phase_fraction,
  moon_distance_km: moon.dist * KM_PER_AU,
});
```

The Julian fields come from Task 5, so this module supplies only the remaining seven astronomical values while the assembled group still totals ten.

- [ ] **Step 5: Run golden, boundary, and range tests**

Run: `corepack pnpm test:run -- src/fantasy5/astronomy/astronomy.test.ts`

Expected: Lichun is within 120 seconds; all angular and range assertions pass.

- [ ] **Step 6: Commit astronomy calculations**

```powershell
git add src/fantasy5/astronomy src/fantasy5/test/fixtures/solar-term-golden.json
git commit -m "feat: calculate solar term and lunar phase indicators"
```

### Task 8: Derive four pillars from explicit boundaries

**Files:**
- Create: `src/fantasy5/traditional/tables.ts`
- Create: `src/fantasy5/traditional/pillars.ts`
- Create: `src/fantasy5/traditional/pillars.test.ts`
- Create: `src/fantasy5/test/fixtures/pillar-golden.json`

- [ ] **Step 1: Add three golden dates and boundary tests**

```json
[
  { "local": "1986-05-29T18:25:00", "year": "丙寅", "month": "癸巳", "day": "癸酉", "hour": "辛酉" },
  { "local": "2024-02-04T00:25:00", "boundary": "before-lichun" },
  { "local": "2024-02-04T01:25:00", "boundary": "after-lichun" }
]
```

Use the exact Los Angeles Lichun conversion calculated in Task 7 rather than assuming the two illustrative boundary labels above; update the fixture instants to one minute before and one minute after the calculated local boundary before committing.

```ts
it('returns the documented 1986 pillars at 18:25', () => {
  expect(buildPillars(contextFor('1986-05-29'))).toMatchObject({
    year_ganzhi: '丙寅', month_ganzhi: '癸巳', day_ganzhi: '癸酉', hour_ganzhi: '辛酉',
  });
});

it('changes year and month only after the exact term instant', () => {
  const before = buildPillars(contextOneMinuteBeforeLichun);
  const after = buildPillars(contextOneMinuteAfterLichun);
  expect(before.year_ganzhi_index_60).not.toBe(after.year_ganzhi_index_60);
  expect(before.month_ganzhi_index_60).not.toBe(after.month_ganzhi_index_60);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/pillars.test.ts`

Expected: FAIL because tables and pillar derivation do not exist.

- [ ] **Step 3: Implement immutable stem/branch tables**

```ts
export const STEMS = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'] as const;
export const BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'] as const;
export const STEM_ELEMENTS = ['wood','wood','fire','fire','earth','earth','metal','metal','water','water'] as const;
export const BRANCH_ELEMENTS = ['water','earth','wood','wood','earth','fire','fire','earth','metal','metal','earth','water'] as const;
export const YIN_YANG = ['yang','yin'] as const;
```

Generate the 60 JiaZi pairs only where stem and branch parity match. Add full readonly tables for hidden stems, 30 nayin pairs, day-master growth stages, mansion mappings, and nine-star names in this file; tests assert table lengths and unique keys.

- [ ] **Step 4: Implement pillar derivation**

Use Task 7's exact Lichun and twelve-jie boundaries for year and month. Use a locked JDN sexagenary offset verified by all three fixture dates. Day changes at local `00:00`; hour branch is `Math.floor((hour + 1) / 2) % 12`; hour stem is `(2 * dayStemIndex + hourBranchIndex) % 10`.

```ts
function pillar(index60: number): PillarFields {
  const normalized = mod(index60, 60);
  const stem = normalized % 10;
  const branch = normalized % 12;
  return {
    ganzhiIndex60: normalized,
    stemIndex10: stem,
    branchIndex12: branch,
    stemElement: STEM_ELEMENTS[stem],
    branchElement: BRANCH_ELEMENTS[branch],
    stemYinYang: YIN_YANG[stem % 2],
    branchYinYang: YIN_YANG[branch % 2],
  };
}
```

- [ ] **Step 5: Run pillar and table tests**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/pillars.test.ts`

Expected: golden pillars pass; year/month switch at the exact term instant; 18:25 always maps to 酉.

- [ ] **Step 6: Commit four-pillar rules**

```powershell
git add src/fantasy5/traditional/tables.ts src/fantasy5/traditional/pillars.ts src/fantasy5/traditional/pillars.test.ts src/fantasy5/test/fixtures/pillar-golden.json
git commit -m "feat: derive fantasy 5 moment pillars"
```

### Task 9: Add auxiliary traditional indicators

**Files:**
- Create: `src/fantasy5/traditional/auxiliary.ts`
- Create: `src/fantasy5/traditional/auxiliary.test.ts`

- [ ] **Step 1: Write failing formula and count tests**

```ts
describe('traditional auxiliary indicators', () => {
  it('calculates 建 when day branch equals month branch', () => {
    expect(dayOfficer(2, 2)).toEqual({ offset: 0, index: 0, name: '建' });
  });

  it('maps every mansion into one quadrant and luminary', () => {
    for (let jdn = 2_450_000; jdn < 2_450_028; jdn += 1) {
      const mansion = mansionForJdn(jdn);
      expect(mansion.index).toBeGreaterThanOrEqual(0);
      expect(mansion.index).toBeLessThan(28);
      expect(mansion.quadrantIndex).toBeGreaterThanOrEqual(0);
      expect(mansion.quadrantIndex).toBeLessThan(4);
    }
  });

  it('returns exactly 31 auxiliary fields', () => {
    expect(Object.keys(buildAuxiliaryIndicators(fixturePillars))).toHaveLength(31);
  });
});
```

The 31 fields are `18 + 4 + 5 + 4` from sections 4.6 through 4.9 of the design.

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/auxiliary.test.ts`

Expected: FAIL because `auxiliary.ts` is missing.

- [ ] **Step 3: Implement table-driven auxiliary formulas**

```ts
export function dayOfficer(monthBranch: number, dayBranch: number) {
  const offset = mod(dayBranch - monthBranch, 12);
  return Object.freeze({ offset, index: offset, name: OFFICERS[offset] });
}

export function mansionForJdn(jdn: number) {
  const index = mod(jdn - MANSION_EPOCH.jdn + MANSION_EPOCH.index, 28);
  return Object.freeze({
    index,
    name: MANSIONS[index],
    quadrantIndex: Math.floor(index / 7),
    luminaryIndex: index % 7,
  });
}
```

Implement main hidden stems from the readonly branch table; ten gods from five-element generation/control plus polarity; each pillar's xun as `Math.floor(ganzhiIndex60 / 10)`; xun-kong as the two branches absent from that ten-pair segment; day/hour nayin from `Math.floor(ganzhiIndex60 / 2)`; four growth stages from `GROWTH_STAGE_BY_STEM_BRANCH`.

- [ ] **Step 4: Run auxiliary tests**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/auxiliary.test.ts`

Expected: formula, range, and exact 31-field count tests pass.

- [ ] **Step 5: Commit auxiliary indicators**

```powershell
git add src/fantasy5/traditional/auxiliary.ts src/fantasy5/traditional/auxiliary.test.ts
git commit -m "feat: add traditional time indicators"
```

### Task 10: Add nine-star and experimental Qimen summaries

**Files:**
- Create: `src/fantasy5/traditional/nine-stars.ts`
- Create: `src/fantasy5/traditional/qimen-summary.ts`
- Create: `src/fantasy5/traditional/time-systems.test.ts`
- Create: `src/fantasy5/test/fixtures/time-systems-golden.json`

- [ ] **Step 1: Write failing repeatability and invariant tests**

```ts
describe('nine stars and Qimen summary', () => {
  it('returns four stars and four cycle directions', () => {
    const result = buildNineStars(fixtureContext);
    expect(Object.keys(result)).toHaveLength(8);
    expect([1,2,3,4,5,6,7,8,9]).toContain(result.day_star_number);
  });

  it('returns a deterministic eight-field Qimen summary', () => {
    const first = buildQimenSummary(fixtureContext);
    expect(first).toEqual(buildQimenSummary(fixtureContext));
    expect(Object.keys(first)).toHaveLength(8);
    expect(['yin', 'yang']).toContain(first.qimen_dun);
    expect(first.qimen_ju_number).toBeGreaterThanOrEqual(1);
    expect(first.qimen_ju_number).toBeLessThanOrEqual(9);
    expect(first.qimen_method_version).toBe('split-complement-rotating-v1-experimental');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/time-systems.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement nine stars behind a versioned adapter**

Construct `Solar.fromYmdHms(...).getLunar()` from local parts, then map `getYearNineStar()`, `getMonthNineStar()`, `getDayNineStar()`, and `getTimeNineStar()` into numbers 1～9. Store four direction/cycle codes using the library's documented nine-star index and the fixed `nineStar` rule version. Never include star luck, color, or direction descriptions.

- [ ] **Step 4: Implement the Qimen split-complement rotating summary**

Keep the algorithm in local readonly tables rather than adding another runtime dependency. Use the exact adjacent term from Task 7, the day/hour JiaZi indices from Task 8, and these declared rules:

- Yang Dun from winter-solstice sector through the instant before summer solstice; Yin Dun otherwise.
- Yuan is `Math.floor((dayGanzhiIndex60 % 15) / 5)` mapped to `upper|middle|lower`.
- Ju number is looked up from a complete `24 terms × 3 yuan` readonly table committed in `qimen-summary.ts`.
- Day and hour xun heads use the same six-xun function from Task 9.
- Chief star and chief door are derived from the duty palace of the hour xun head using the rotating-chart star and door tables.

```ts
export function buildQimenSummary(ctx: TraditionalContext): QimenSummary {
  const dun = isYangDun(ctx.instant, ctx.solstices) ? 'yang' : 'yin';
  const yuanIndex = Math.floor((ctx.pillars.day.ganzhiIndex60 % 15) / 5);
  const ju = QIMEN_JU_TABLE[ctx.currentTerm.index][yuanIndex];
  const dayXun = xunFor(ctx.pillars.day.ganzhiIndex60);
  const hourXun = xunFor(ctx.pillars.hour.ganzhiIndex60);
  const dutyPalace = dutyPalaceFor({ dun, ju, hourXun });
  return Object.freeze({
    qimen_dun: dun,
    qimen_ju_number: ju,
    qimen_yuan: YUAN[yuanIndex],
    qimen_day_xun_head: dayXun.head,
    qimen_hour_xun_head: hourXun.head,
    qimen_chief_star: STARS[dutyPalace],
    qimen_chief_door: DOORS[dutyPalace],
    qimen_method_version: VERSIONS.qimen,
  });
}
```

Add two independently generated comparison cases to `time-systems-golden.json`. Until both match, keep the version suffix `-experimental` and exclude all eight fields from the model-feature dictionary. A mismatch fails only the `golden comparison` test; it must not be hidden by changing expected fixtures to current output.

- [ ] **Step 5: Run time-system tests**

Run: `corepack pnpm test:run -- src/fantasy5/traditional/time-systems.test.ts`

Expected: eight-field counts, ranges, repeatability, and both checked fixture cases pass.

- [ ] **Step 6: Commit time-system indicators**

```powershell
git add src/fantasy5/traditional/nine-stars.ts src/fantasy5/traditional/qimen-summary.ts src/fantasy5/traditional/time-systems.test.ts src/fantasy5/test/fixtures/time-systems-golden.json
git commit -m "feat: add nine star and qimen summaries"
```

### Task 11: Assemble and validate the complete immutable snapshot

**Files:**
- Create: `src/fantasy5/build-time-snapshot.ts`
- Create: `src/fantasy5/build-time-snapshot.test.ts`

- [ ] **Step 1: Write failing complete-snapshot tests**

```ts
import { describe, expect, it } from 'vitest';
import { AUDIT_KEYS, INDICATOR_KEYS } from './domain/indicator-dictionary.js';
import { buildTimeSnapshot } from './build-time-snapshot.js';

describe('buildTimeSnapshot', () => {
  it('returns exactly eight audit fields and 118 ordered indicators', () => {
    const snapshot = buildTimeSnapshot('2026-07-19', '2026-07-20T03:00:00Z');
    expect(Object.keys(snapshot.audit)).toEqual(AUDIT_KEYS);
    expect(Object.keys(snapshot.indicators)).toEqual(INDICATOR_KEYS);
    expect(snapshot.audit.nominal_local_time).toBe('18:25:00');
    expect(snapshot.audit.location_used).toBe(false);
  });

  it('is deeply immutable and deterministic apart from computed_at', () => {
    const at = '2026-07-20T03:00:00Z';
    expect(buildTimeSnapshot('1992-02-04', at)).toEqual(buildTimeSnapshot('1992-02-04', at));
    expect(Object.isFrozen(buildTimeSnapshot('1992-02-04', at).indicators)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify missing orchestrator failure**

Run: `corepack pnpm test:run -- src/fantasy5/build-time-snapshot.test.ts`

Expected: FAIL because `buildTimeSnapshot` does not exist.

- [ ] **Step 3: Implement orchestration and exact-key validation**

```ts
export function buildTimeSnapshot(drawDate: string, computedAtUtc = new Date().toISOString()): TimeSnapshot {
  const moment = resolveDrawMoment(drawDate);
  const civil = buildCivilCalendar(moment);
  const lunar = buildLunarCalendar(localParts(moment));
  const terms = buildSolarTermIndicators(moment);
  const astronomy = buildAstronomyIndicators(moment, civil);
  const pillars = buildPillars({ moment, terms });
  const auxiliary = buildAuxiliaryIndicators(pillars);
  const nineStars = buildNineStars({ moment, lunar, pillars, terms });
  const qimen = buildQimenSummary({ moment, pillars, terms });
  const indicators = orderAndValidateIndicators({ ...civil, ...lunar, ...terms, ...astronomy, ...pillars.flat, ...auxiliary, ...nineStars, ...qimen });
  return deepFreeze({ audit: buildAudit(drawDate, computedAtUtc), indicators });
}
```

`orderAndValidateIndicators` must throw on a missing key, unknown key, `undefined`, non-finite number, or count other than 118. It constructs the object by iterating `INDICATOR_KEYS`, guaranteeing stable CSV order.

- [ ] **Step 4: Run the complete core suite with coverage**

Run: `corepack pnpm test:coverage -- src/fantasy5`

Expected: all tests pass and `src/fantasy5/**` reaches at least 90% statements, 85% branches, 90% functions, and 90% lines.

- [ ] **Step 5: Commit snapshot orchestration**

```powershell
git add src/fantasy5/build-time-snapshot.ts src/fantasy5/build-time-snapshot.test.ts
git commit -m "feat: assemble 118 fantasy 5 time indicators"
```

### Task 12: Export an enriched history CSV and manifest

**Files:**
- Create: `src/fantasy5/io/enrich-history.ts`
- Create: `src/fantasy5/io/enrich-history.test.ts`
- Create: `src/fantasy5/cli/enrich-fantasy5.ts`
- Create: `data/derived/.gitkeep`

- [ ] **Step 1: Write failing export tests**

```ts
describe('enrichHistory', () => {
  it('preserves source columns and appends 126 canonical fields', async () => {
    const result = await enrichHistory({
      inputPath: 'src/fantasy5/test/fixtures/history-small.csv',
      outputPath: tempCsv,
      manifestPath: tempManifest,
      computedAtUtc: '2026-07-20T03:00:00Z',
    });
    expect(result.rowCount).toBe(3);
    expect(result.auditFieldCount).toBe(8);
    expect(result.indicatorFieldCount).toBe(118);
    expect(result.firstDrawDate).toBe('1992-02-04');
    expect(result.lastDrawDate).toBe('2026-07-18');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm test:run -- src/fantasy5/io/enrich-history.test.ts`

Expected: FAIL because the exporter does not exist.

- [ ] **Step 3: Implement stable CSV and JSON manifest output**

```ts
export interface EnrichmentManifest {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly rowCount: number;
  readonly firstDrawDate: string;
  readonly lastDrawDate: string;
  readonly sourceFieldCount: 11;
  readonly auditFieldCount: 8;
  readonly indicatorFieldCount: 118;
  readonly algorithmBundleVersion: string;
  readonly sha256: string;
}
```

Write rows in ascending date order with the original 11 columns, then eight audit columns, then 118 indicator columns. Use a temporary sibling file and `rename` only after writing finishes so an interrupted run does not leave a partial official output. Hash the final bytes with SHA-256 and write the manifest beside the CSV.

- [ ] **Step 4: Implement CLI argument validation**

```powershell
corepack pnpm fantasy5:enrich -- --input "C:\Users\zexim\Downloads\california_fantasy_5_complete_history.csv" --output "data\derived\california_fantasy_5_time_indicators_v1.csv" --manifest "data\derived\california_fantasy_5_time_indicators_v1.manifest.json"
```

The CLI exits `2` for missing/invalid arguments, `1` for parsing or calculation failures, and `0` only after both output files are complete. Print row count, date range, field counts, elapsed time, and SHA-256; never print every row.

- [ ] **Step 5: Run fixture export tests**

Run: `corepack pnpm test:run -- src/fantasy5/io/enrich-history.test.ts`

Expected: the three-row fixture exports, the manifest has a 64-character hash, and field counts are exact.

- [ ] **Step 6: Commit exporter and CLI**

```powershell
git add src/fantasy5/io/enrich-history.ts src/fantasy5/io/enrich-history.test.ts src/fantasy5/cli/enrich-fantasy5.ts data/derived/.gitkeep
git commit -m "feat: export fantasy 5 indicator history"
```

### Task 13: Run the full history and verify artifacts

**Files:**
- Create: `src/fantasy5/io/full-history.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add an opt-in full-history integration test**

```ts
const source = process.env.FANTASY5_HISTORY_CSV;
describe.skipIf(!source)('full Fantasy 5 history', () => {
  it('parses all expected rows and produces one snapshot per date', async () => {
    const rows = await readHistoryCsv(source!);
    expect(rows).toHaveLength(11860);
    expect(rows[0]?.drawDate).toBe('1992-02-04');
    for (const row of rows) {
      expect(Object.keys(buildTimeSnapshot(row.drawDate, '2026-07-20T03:00:00Z').indicators)).toHaveLength(118);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run all unit tests, typecheck, and build**

Run: `corepack pnpm typecheck && corepack pnpm test:coverage && corepack pnpm build`

Expected: all commands exit `0`; coverage meets Task 11 thresholds.

- [ ] **Step 3: Run the opt-in full-history test**

Run:

```powershell
$env:FANTASY5_HISTORY_CSV='C:\Users\zexim\Downloads\california_fantasy_5_complete_history.csv'
corepack pnpm test:run -- src/fantasy5/io/full-history.integration.test.ts
Remove-Item Env:FANTASY5_HISTORY_CSV
```

Expected: `11,860` rows pass, with no invalid date, duplicate date, or indicator-cardinality error.

- [ ] **Step 4: Generate the official v1 derived artifacts**

Run:

```powershell
corepack pnpm fantasy5:enrich -- --input 'C:\Users\zexim\Downloads\california_fantasy_5_complete_history.csv' --output 'data\derived\california_fantasy_5_time_indicators_v1.csv' --manifest 'data\derived\california_fantasy_5_time_indicators_v1.manifest.json'
```

Expected: CLI reports 11,860 rows, eight audit fields, 118 indicators, chronological range, and a SHA-256 hash. Generated data stays untracked because it is reproducible and approximately much larger than source code.

- [ ] **Step 5: Document reproducibility and limitations**

Add to `README.md`:

- the fixed `18:25 America/Los_Angeles` anchor;
- exact dependency and algorithm versions;
- input CSV schema and command;
- output field counts and manifest format;
- no-coordinate/no-personal-chart boundary;
- Qimen experimental status and exclusion from first-round modeling;
- the difference between historical association and lottery prediction;
- commands for unit, coverage, integration, and enrichment runs.

- [ ] **Step 6: Review generated samples manually**

Inspect the first two, a winter/summer pair, a solar-term boundary pair, and the final two output rows. Confirm source numbers are unchanged, local time is always 18:25, UTC offsets switch only according to IANA rules, every row has the same column count, and all numeric fields are finite.

- [ ] **Step 7: Commit final verification and documentation**

```powershell
git add README.md src/fantasy5/io/full-history.integration.test.ts
git commit -m "test: verify complete fantasy 5 indicator history"
```

## Plan self-review

- **Spec coverage:** Tasks 2 and 11 lock the 118+8 contract. Tasks 4–10 calculate all groups. Tasks 3, 12, and 13 ingest and enrich the complete CSV. The 64 model-time features and 17 number-history features remain specified but are intentionally deferred to the probability-model plan because this plan ends with a validated time dataset.
- **Boundary coverage:** Winter/PDT offsets, day-tail zero, leap year, J2000, Lichun, pillar boundaries, 18:25 酉时, table ranges, exact field counts, and full history receive explicit tests.
- **Leakage check:** This phase calculates only same-draw time fields and never reads a draw's numbers while building its time snapshot. Historical rolling features are not implemented here, so current/future leakage cannot enter this artifact.
- **Type consistency:** `SourceDraw` flows from `readHistoryCsv`; `buildTimeSnapshot(drawDate, computedAtUtc)` returns `TimeSnapshot`; `enrichHistory` flattens `AuditMetadata` and `FlatIndicators` in dictionary order.
- **Placeholder scan:** No implementation placeholder or undefined task remains. The Qimen method is fixed, versioned, fixture-gated, marked experimental, and excluded from modeling until independent comparisons pass.
- **Scope check:** Probability scoring and the `/5` page are separate independently testable subsystems. Their plans should start only after the enriched history manifest and sample rows are approved.
