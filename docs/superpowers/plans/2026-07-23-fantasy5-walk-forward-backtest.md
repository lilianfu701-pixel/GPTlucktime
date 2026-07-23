# Fantasy 5 Walk-Forward Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, no-lookahead Fantasy 5 walk-forward backtest with a default 10-draw view and selectable 20, 30, and 50-draw windows.

**Architecture:** Move the current empirical-Bayes frequency ranking into a reusable model module. For every evaluated draw, build the ranking from rows strictly earlier than the target draw, retain the top five and all 39 marginal probabilities, then aggregate hit-rate and proper-scoring metrics. Embed the precomputed report in the static Worker and render window controls, summary metrics, and a draw-by-draw audit table in the browser.

**Tech Stack:** Node.js 22+ ESM, built-in `node:test`, generated static HTML/JavaScript, Cloudflare Worker-compatible ESM.

---

### Task 1: Reusable Model and Walk-Forward Engine

**Files:**
- Create: `fantasy5-site/lib/fantasy5-model.mjs`
- Create: `fantasy5-site/tests/fantasy5-model.test.mjs`
- Modify: `fantasy5-site/scripts/build-static-worker.mjs`

- [ ] **Step 1: Write the failing model tests**

Test the following public API:

```js
import {
  BASELINE_AVERAGE_HITS,
  MODEL_VERSION,
  buildRecommendations,
  buildWalkForwardBacktest,
  summarizeBacktest,
} from "../lib/fantasy5-model.mjs";
```

The tests must prove:

```js
const results = buildWalkForwardBacktest(history, {
  drawCount: 10,
  minTrainingDraws: 3,
});

assert.equal(results.length, 10);
assert.ok(results.every((row) => row.trainingCutoffDate < row.drawDate));
assert.ok(results.every((row) => row.predictedNumbers.length === 5));
assert.ok(results.every((row) => row.probabilities.length === 39));
```

Clone the history, change only the final draw's actual numbers, run the same backtest again, and assert that every `predictedNumbers` array is unchanged. This is the regression proof that target results do not enter their own prediction.

- [ ] **Step 2: Run the model test and verify RED**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Expected: FAIL with module-not-found for `../lib/fantasy5-model.mjs`.

- [ ] **Step 3: Implement the model module**

`buildRecommendations(history)` must return 39 rows sorted by descending empirical-Bayes probability:

```js
const baseline = 5 / 39;
const priorDraws = 90;
const probability =
  (numberHitCount + baseline * priorDraws) /
  (trainingDrawCount + priorDraws);
```

`buildWalkForwardBacktest(history, options)` must:

1. Sort no data randomly and preserve ascending draw order.
2. Evaluate only the final `drawCount` eligible draws.
3. Pass `history.slice(0, targetIndex)` to the recommender.
4. Store `drawDate`, `trainingCutoffDate`, `trainingDrawCount`, `predictedNumbers`, `actualNumbers`, `hitNumbers`, `hitCount`, `probabilities`, `brierScore`, and `logLoss`.
5. Return newest evaluated draw first for page display.

For each draw and each number `n`:

```js
const outcome = actualNumbers.includes(n) ? 1 : 0;
const p = clamp(probability / 100, 1e-9, 1 - 1e-9);
const brierTerm = (p - outcome) ** 2;
const logLossTerm = -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
```

`summarizeBacktest(results)` must return:

```js
{
  drawCount,
  averageHits,
  atLeastOneRate,
  atLeastTwoRate,
  brierScore,
  logLoss,
  randomBaselineAverageHits: 25 / 39,
  averageHitLift,
}
```

- [ ] **Step 4: Run the model test and verify GREEN**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Expected: all model tests PASS.

- [ ] **Step 5: Use the reusable model in the build**

Remove the local `buildRecommendations` function from `build-static-worker.mjs` and import the model module. Build next-draw recommendations from all valid rows, not the 300 display rows:

```js
const recommendations = buildRecommendations(validRows);
const backtestResults = buildWalkForwardBacktest(validRows, {
  drawCount: 50,
  minTrainingDraws: 365,
});
const backtest = {
  modelVersion: MODEL_VERSION,
  defaultDrawCount: 10,
  availableDrawCounts: [10, 20, 30, 50].filter(
    (count) => count <= backtestResults.length,
  ),
  results: backtestResults,
  summaries: Object.fromEntries(
    [10, 20, 30, 50]
      .filter((count) => count <= backtestResults.length)
      .map((count) => [count, summarizeBacktest(backtestResults.slice(0, count))]),
  ),
};
```

### Task 2: Backtest Dashboard and Draw Audit Table

**Files:**
- Modify: `fantasy5-site/scripts/build-static-worker.mjs`
- Modify: `fantasy5-site/tests/rendered-html.test.mjs`

- [ ] **Step 1: Write the failing rendered-page assertions**

Require the generated page to contain:

```js
assert.match(html, /滚动回测/);
assert.match(html, /window\.F5_BACKTEST/);
assert.match(html, /data-backtest-count="10"/);
assert.match(html, /id="backtest-body"/);
assert.match(html, /严禁未来数据参与/);
```

- [ ] **Step 2: Run the rendered test and verify RED**

Run:

```powershell
npm.cmd run build
node --test tests/rendered-html.test.mjs
```

Expected: FAIL because the backtest section and `F5_BACKTEST` payload do not exist.

- [ ] **Step 3: Add the backtest UI**

Add a card below the probability ranking containing:

1. Title `滚动回测（最近 10 期）`.
2. Buttons for each available draw count, defaulting to 10.
3. Summary fields for average top-five hits, at-least-one rate, at-least-two rate, Brier Score, Log Loss, and average hit lift versus the random baseline.
4. A scrollable table with draw date, training cutoff, model top five, actual five numbers, hit numbers, and hit count.
5. A visible note: each row uses only earlier draws, no target or later result is included; small samples fluctuate and do not guarantee future performance.

Embed:

```js
window.F5_BACKTEST = ${JSON.stringify(backtest)};
```

Client rendering must use the existing number-button helper so selected-number highlighting also applies to the backtest table. Numbers hit by both prediction and actual result receive an additional `.backtest-hit` class.

- [ ] **Step 4: Implement window switching**

On a backtest-count button click:

1. Read the precomputed summary for that count.
2. Render the newest `count` result rows.
3. Update the title and active button.
4. Preserve the currently selected number's cross-page highlight.

- [ ] **Step 5: Run all tests**

Run:

```powershell
npm.cmd test
```

Expected: all tests PASS and the build produces `dist/server/index.js` and `preview.html`.

### Task 3: Verification and Private Deployment

**Files:**
- Verify: `fantasy5-site/preview.html`
- Verify: `fantasy5-site/dist/server/index.js`

- [ ] **Step 1: Verify generated content**

Run:

```powershell
rg -n "滚动回测|window.F5_BACKTEST|严禁未来数据参与|Brier|Log Loss" preview.html
```

Expected: all required labels and the embedded payload are present.

- [ ] **Step 2: Verify repository scope**

Run:

```powershell
git diff --check
git status --short
```

Expected: only the backtest plan, model module, model tests, build script, rendered HTML test, and regenerated preview are changed. Preserve the two existing untracked 2026-07-19 documents.

- [ ] **Step 3: Commit and deploy**

Commit the validated source, push the exact commit to the existing Sites source repository, package the corresponding `dist`, save one new version, and deploy privately without changing access policy or domain.

- [ ] **Step 4: Poll deployment**

Poll the deployment until `succeeded`, then report the production URL and the default/available backtest windows.
