# Fantasy 5 400 期动态模型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Fantasy 5 推荐改为只使用最近 400 期、随目标日期指标变化的 Top 15 模型，统一展示 400 期滚动回测，并为五行文字着色、删除时支五行。

**Architecture:** 保留现有纯 Node 静态构建架构，在 `fantasy5-model.mjs` 内集中实现窗口校验、经验贝叶斯动态评分、概率归一化、Top 15 walk-forward 回测和汇总。构建脚本继续负责日期推演与 HTML 生成，但在调用模型前为训练记录补齐指标；页面只消费构建时嵌入的确定性 JSON，不增加客户端 API 或外部依赖。

**Tech Stack:** Node.js 22 ESM、`node:test`、静态 HTML/CSS/JavaScript、现有 Sites 私有托管项目。

---

## 文件结构

- 修改 `fantasy5-site/lib/fantasy5-model.mjs`：400 期动态评分、Top 15、严格滚动回测、汇总统计。
- 修改 `fantasy5-site/tests/fantasy5-model.test.mjs`：模型窗口、动态性、确定性、防穿越和汇总测试。
- 修改 `fantasy5-site/scripts/build-static-worker.mjs`：日期指标输入、400 期回测数据、Top 15 页面、五行颜色、删除时支五行。
- 修改 `fantasy5-site/tests/rendered-html.test.mjs`：静态页面结构、颜色标签、Top 15 和统一 400 期口径测试。
- 重新生成 `fantasy5-site/preview.html` 与 `fantasy5-site/dist/`：由既有构建脚本产生；只提交仓库中已经跟踪且与本功能直接相关的构建产物。

### Task 1: 用失败测试定义 400 期动态推荐接口

**Files:**
- Modify: `fantasy5-site/tests/fantasy5-model.test.mjs`
- Test: `fantasy5-site/tests/fantasy5-model.test.mjs`

- [ ] **Step 1: 将测试夹具扩展为包含日期指标的有效记录**

在测试文件中加入固定指标生成器，并让 `historyRow` 返回模型需要的字段：

```js
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const branches = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const elementByStem = {
  甲: "木", 乙: "木", 丙: "火", 丁: "火", 戊: "土",
  己: "土", 庚: "金", 辛: "金", 壬: "水", 癸: "水",
};

function indicatorsAt(index) {
  const dayStem = stems[index % stems.length];
  const hourStem = stems[(index * 3 + 1) % stems.length];
  return {
    weekday: weekdays[index % weekdays.length],
    tail: index % 10,
    dayStem,
    dayBranch: branches[index % branches.length],
    dayElement: elementByStem[dayStem],
    hourStem,
    hourStemElement: elementByStem[hourStem],
  };
}

function historyRow(index, overrides = {}) {
  return {
    draw_date: dateAt(index),
    numbers: Array.from(
      { length: 5 },
      (_, offset) => ((index * 3 + offset * 7) % 39) + 1,
    ),
    ...indicatorsAt(index),
    ...overrides,
  };
}
```

- [ ] **Step 2: 写出窗口、Top 15、概率质量和确定性的失败测试**

用以下测试替换旧的 12 期全历史推荐测试：

```js
test("buildRecommendations requires 400 draws and returns a deterministic Top 15 ranking", () => {
  const history = Array.from({ length: 400 }, (_, index) => historyRow(index));
  const target = indicatorsAt(401);

  assert.throws(
    () => buildRecommendations(history.slice(1), target),
    /exactly 400 training draws/,
  );

  const first = buildRecommendations(history, target);
  const second = buildRecommendations(history, target);

  assert.deepEqual(second, first);
  assert.equal(first.length, 39);
  assert.equal(new Set(first.map((item) => item.number)).size, 39);
  assert.equal(new Set(first.slice(0, 15).map((item) => item.number)).size, 15);
  assert.ok(first.every((item) => item.number >= 1 && item.number <= 39));
  assert.ok(first.every((item) => item.probability > 0 && item.probability < 100));
  assert.ok(
    first.every(
      (item, index) =>
        index === 0 || first[index - 1].probability >= item.probability,
    ),
  );
  const probabilityMass = first.reduce(
    (total, item) => total + item.probability,
    0,
  );
  assert.ok(Math.abs(probabilityMass - 500) < 0.05);
});
```

- [ ] **Step 3: 写出“只看最近 400 期”和日期指标改变排名的失败测试**

```js
test("recommendations ignore history older than 400 draws", () => {
  const recent = Array.from({ length: 400 }, (_, index) => historyRow(index + 10));
  const olderA = Array.from({ length: 10 }, (_, index) =>
    historyRow(index, { numbers: [1, 2, 3, 4, 5] }),
  );
  const olderB = Array.from({ length: 10 }, (_, index) =>
    historyRow(index, { numbers: [35, 36, 37, 38, 39] }),
  );
  const target = indicatorsAt(411);

  assert.deepEqual(
    buildRecommendations([...olderA, ...recent], target),
    buildRecommendations([...olderB, ...recent], target),
  );
});

test("target date indicators change the ranked recommendations", () => {
  const history = Array.from({ length: 400 }, (_, index) => {
    const favored = index % 2 === 0 ? [1, 2, 3, 4, 5] : [35, 36, 37, 38, 39];
    return historyRow(index, {
      numbers: favored,
      weekday: index % 2 === 0 ? "周一" : "周二",
      dayStem: index % 2 === 0 ? "甲" : "庚",
      dayElement: index % 2 === 0 ? "木" : "金",
    });
  });
  const mondayWood = {
    ...indicatorsAt(401),
    weekday: "周一",
    dayStem: "甲",
    dayElement: "木",
  };
  const tuesdayMetal = {
    ...indicatorsAt(402),
    weekday: "周二",
    dayStem: "庚",
    dayElement: "金",
  };

  assert.notDeepEqual(
    buildRecommendations(history, mondayWood).slice(0, 15),
    buildRecommendations(history, tuesdayMetal).slice(0, 15),
  );
});
```

- [ ] **Step 4: 运行模型测试并确认按预期失败**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Working directory: `fantasy5-site`

Expected: FAIL，错误应指出当前 `buildRecommendations` 不接收目标指标、允许不足 400 期或仍按旧接口工作；不得是语法错误。

- [ ] **Step 5: 提交测试红灯**

```powershell
git add -- fantasy5-site/tests/fantasy5-model.test.mjs
git commit -m "test: define Fantasy 5 dynamic 400-draw model"
```

### Task 2: 实现收缩式日期条件模型

**Files:**
- Modify: `fantasy5-site/lib/fantasy5-model.mjs`
- Test: `fantasy5-site/tests/fantasy5-model.test.mjs`

- [ ] **Step 1: 定义模型常量、指标组和输入校验**

将文件顶部常量改为：

```js
export const BASELINE_PROBABILITY = 5 / 39;
export const TRAINING_DRAW_COUNT = 400;
export const RECOMMENDATION_COUNT = 15;
export const BASELINE_AVERAGE_HITS =
  (RECOMMENDATION_COUNT * 5) / 39;
export const MODEL_VERSION = "F5-EB-TIME400-TOP15-v2";

const PRIOR_DRAWS = 90;
const CONDITIONAL_PRIOR_DRAWS = 30;
const RECENCY_HALF_LIFE = 240;
const SCORE_EPSILON = 1e-9;
const FEATURE_GROUPS = [
  { weight: 1 / 30, fields: ["weekday", "tail"] },
  { weight: 2 / 45, fields: ["dayStem", "dayBranch", "dayElement"] },
  { weight: 1 / 45, fields: ["hourStem", "hourStemElement"] },
];
const REQUIRED_INDICATORS = FEATURE_GROUPS.flatMap((group) => group.fields);
```

加入真实输入校验：

```js
function validateNumbers(numbers, label) {
  if (
    !Array.isArray(numbers) ||
    numbers.length !== 5 ||
    new Set(numbers).size !== 5 ||
    numbers.some(
      (number) => !Number.isInteger(number) || number < 1 || number > 39,
    )
  ) {
    throw new Error(`${label} must contain five unique numbers from 1 to 39`);
  }
}

function validateIndicators(row, label) {
  for (const field of REQUIRED_INDICATORS) {
    if (row[field] === undefined || row[field] === null || row[field] === "") {
      throw new Error(`${label} is missing indicator ${field}`);
    }
  }
}

function normalizeTrainingWindow(history) {
  if (!Array.isArray(history) || history.length < TRAINING_DRAW_COUNT) {
    throw new Error("buildRecommendations requires exactly 400 training draws");
  }
  const window = [...history]
    .sort((left, right) => left.draw_date.localeCompare(right.draw_date))
    .slice(-TRAINING_DRAW_COUNT);
  window.forEach((row, index) => {
    validateNumbers(row.numbers, `history[${index}].numbers`);
    validateIndicators(row, `history[${index}]`);
  });
  return window;
}
```

- [ ] **Step 2: 实现衰减、条件概率和组 log-odds**

加入：

```js
function logit(probability) {
  const safe = clamp(probability, SCORE_EPSILON, 1 - SCORE_EPSILON);
  return Math.log(safe / (1 - safe));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function drawWeight(index) {
  const age = TRAINING_DRAW_COUNT - 1 - index;
  return 2 ** (-age / RECENCY_HALF_LIFE);
}

function weightedFrequency(window, number, predicate = () => true) {
  let weightedDraws = 0;
  let weightedHits = 0;
  window.forEach((row, index) => {
    if (!predicate(row)) return;
    const weight = drawWeight(index);
    weightedDraws += weight;
    if (row.numbers.includes(number)) weightedHits += weight;
  });
  return { weightedDraws, weightedHits };
}

function featureProbability(window, number, target, field, baseProbability) {
  const distinctValues = new Set(window.map((row) => row[field]));
  if (distinctValues.size < 2) return null;
  const matched = weightedFrequency(
    window,
    number,
    (row) => row[field] === target[field],
  );
  if (matched.weightedDraws === 0) return null;
  return (
    matched.weightedHits + CONDITIONAL_PRIOR_DRAWS * baseProbability
  ) / (matched.weightedDraws + CONDITIONAL_PRIOR_DRAWS);
}

function combinedWeight(window, number, target) {
  const baseCounts = weightedFrequency(window, number);
  const baseProbability =
    (baseCounts.weightedHits + PRIOR_DRAWS * BASELINE_PROBABILITY) /
    (baseCounts.weightedDraws + PRIOR_DRAWS);
  let baseWeight = 0.9;
  let combinedLogit = 0;

  for (const group of FEATURE_GROUPS) {
    const probabilities = group.fields
      .map((field) =>
        featureProbability(window, number, target, field, baseProbability),
      )
      .filter((probability) => probability !== null);
    if (probabilities.length === 0) {
      baseWeight += group.weight;
      continue;
    }
    const groupLogit =
      probabilities.reduce((sum, probability) => sum + logit(probability), 0) /
      probabilities.length;
    combinedLogit += group.weight * groupLogit;
  }

  combinedLogit += baseWeight * logit(baseProbability);
  return {
    rawWeight: logistic(combinedLogit),
    baseProbability,
    count: window.filter((row) => row.numbers.includes(number)).length,
  };
}
```

- [ ] **Step 3: 实现总概率为 5 的归一化和稳定排序**

加入：

```js
function normalizeProbabilityMass(items, targetMass = 5) {
  const probabilities = new Array(items.length).fill(0);
  let remainingIndexes = items.map((_, index) => index);
  let remainingMass = targetMass;

  while (remainingIndexes.length > 0) {
    const weightSum = remainingIndexes.reduce(
      (sum, index) => sum + items[index].rawWeight,
      0,
    );
    if (!Number.isFinite(weightSum) || weightSum <= 0) {
      throw new Error("probability normalization failed");
    }
    const capped = [];
    for (const index of remainingIndexes) {
      const probability =
        (items[index].rawWeight / weightSum) * remainingMass;
      if (probability >= 1 - SCORE_EPSILON) {
        probabilities[index] = 1 - SCORE_EPSILON;
        remainingMass -= probabilities[index];
        capped.push(index);
      } else {
        probabilities[index] = probability;
      }
    }
    if (capped.length === 0) break;
    remainingIndexes = remainingIndexes.filter(
      (index) => !capped.includes(index),
    );
  }

  return probabilities;
}

export function buildRecommendations(history, targetIndicators) {
  validateIndicators(targetIndicators, "targetIndicators");
  const window = normalizeTrainingWindow(history);
  const scored = Array.from({ length: 39 }, (_, index) => {
    const number = index + 1;
    return { number, ...combinedWeight(window, number, targetIndicators) };
  });
  const probabilities = normalizeProbabilityMass(scored);

  return scored
    .map((item, index) => ({
      number: item.number,
      probability: round(probabilities[index] * 100, 6),
      baseProbability: round(item.baseProbability * 100, 6),
      count: item.count,
    }))
    .sort(
      (left, right) =>
        right.probability - left.probability ||
        right.baseProbability - left.baseProbability ||
        left.number - right.number,
    );
}
```

- [ ] **Step 4: 运行模型测试并修正到绿色**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Working directory: `fantasy5-site`

Expected: Task 1 新增测试 PASS；旧回测测试仍可能因接口尚未迁移而 FAIL，失败应只集中在 walk-forward 旧口径。

- [ ] **Step 5: 提交动态评分实现**

```powershell
git add -- fantasy5-site/lib/fantasy5-model.mjs fantasy5-site/tests/fantasy5-model.test.mjs
git commit -m "feat: add Fantasy 5 dynamic 400-draw scoring"
```

### Task 3: 用测试驱动 Top 15 的 400 期滚动回测

**Files:**
- Modify: `fantasy5-site/tests/fantasy5-model.test.mjs`
- Modify: `fantasy5-site/lib/fantasy5-model.mjs`

- [ ] **Step 1: 将 walk-forward 测试改成 400 期训练和 15 码预测**

```js
test("walk-forward uses exactly the prior 400 draws and never future results", () => {
  const history = Array.from({ length: 805 }, (_, index) => historyRow(index));
  const first = buildWalkForwardBacktest(history, { drawCount: 400 });

  assert.equal(first.length, 400);
  assert.ok(first.every((row) => row.trainingDrawCount === 400));
  assert.ok(first.every((row) => row.trainingStartDate < row.trainingCutoffDate));
  assert.ok(first.every((row) => row.trainingCutoffDate < row.drawDate));
  assert.ok(first.every((row) => row.predictedNumbers.length === 15));
  assert.ok(first.every((row) => new Set(row.predictedNumbers).size === 15));
  assert.ok(first.every((row) => row.legacyPredictedNumbers.length === 15));
  assert.ok(first.every((row) => row.probabilities.length === 39));

  const changedFuture = history.map((row) => ({
    ...row,
    numbers: [...row.numbers],
  }));
  changedFuture.at(-1).numbers = [35, 36, 37, 38, 39];
  const second = buildWalkForwardBacktest(changedFuture, { drawCount: 400 });

  assert.deepEqual(
    second.map((row) => row.predictedNumbers),
    first.map((row) => row.predictedNumbers),
  );
});
```

- [ ] **Step 2: 将汇总测试改成 Top 15 基线、至少命中 3 个和命中分布**

```js
test("summarizeBacktest reports Top 15 hit rates and distribution", () => {
  const results = [
    { hitCount: 0, legacyHitCount: 0 },
    { hitCount: 1, legacyHitCount: 1 },
    { hitCount: 2, legacyHitCount: 1 },
    { hitCount: 3, legacyHitCount: 2 },
  ];
  const summary = summarizeBacktest(results);

  assert.equal(MODEL_VERSION, "F5-EB-TIME400-TOP15-v2");
  assert.equal(summary.drawCount, 4);
  assert.equal(summary.averageHits, 1.5);
  assert.equal(summary.atLeastOneRate, 75);
  assert.equal(summary.atLeastTwoRate, 50);
  assert.equal(summary.atLeastThreeRate, 25);
  assert.deepEqual(summary.hitDistribution, {
    0: 1, 1: 1, 2: 1, 3: 1, 4: 0, 5: 0,
  });
  assert.equal(summary.legacyAverageHits, 1);
  assert.equal(summary.randomBaselineAverageHits, 75 / 39);
  assert.equal(
    summary.averageHitLift,
    Number((1.5 - 75 / 39).toFixed(3)),
  );
});
```

- [ ] **Step 3: 运行测试确认新回测断言失败**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Working directory: `fantasy5-site`

Expected: FAIL，原因应为当前回测使用全部前序数据、Top 5、旧基线或缺少新字段。

- [ ] **Step 4: 将回测实现改为固定窗口和目标期指标**

先在模型文件中保留一个只供同口径对照使用的旧频率排名：

```js
function buildLegacyRecommendations(history) {
  const counts = new Array(40).fill(0);
  history.forEach((row) => {
    row.numbers.forEach((number) => {
      counts[number] += 1;
    });
  });
  return Array.from({ length: 39 }, (_, index) => {
    const number = index + 1;
    return {
      number,
      probability:
        (counts[number] + BASELINE_PROBABILITY * PRIOR_DRAWS) /
        (history.length + PRIOR_DRAWS),
    };
  }).sort(
    (left, right) =>
      right.probability - left.probability || left.number - right.number,
  );
}
```

把 `buildWalkForwardBacktest` 的默认值和循环核心改为：

```js
export function buildWalkForwardBacktest(
  history,
  { drawCount = 400 } = {},
) {
  if (!Number.isInteger(drawCount) || drawCount < 1) {
    throw new Error("drawCount must be a positive integer");
  }
  const chronologicalHistory = [...history].sort((left, right) =>
    left.draw_date.localeCompare(right.draw_date),
  );
  chronologicalHistory.forEach((row, index) => {
    validateNumbers(row.numbers, `history[${index}].numbers`);
    validateIndicators(row, `history[${index}]`);
  });
  const availableTargets = chronologicalHistory.length - TRAINING_DRAW_COUNT;
  const resultCount = Math.min(drawCount, Math.max(availableTargets, 0));
  const firstTargetIndex = chronologicalHistory.length - resultCount;
  const results = [];

  for (
    let targetIndex = firstTargetIndex;
    targetIndex < chronologicalHistory.length;
    targetIndex += 1
  ) {
    const trainingHistory = chronologicalHistory.slice(
      targetIndex - TRAINING_DRAW_COUNT,
      targetIndex,
    );
    const target = chronologicalHistory[targetIndex];
    const recommendations = buildRecommendations(trainingHistory, target);
    const predictedNumbers = recommendations
      .slice(0, RECOMMENDATION_COUNT)
      .map((item) => item.number);
    const legacyPredictedNumbers = buildLegacyRecommendations(trainingHistory)
      .slice(0, RECOMMENDATION_COUNT)
      .map((item) => item.number);
    const actualNumberSet = new Set(target.numbers);
    const hitNumbers = predictedNumbers.filter((number) =>
      actualNumberSet.has(number),
    );
    const legacyHitNumbers = legacyPredictedNumbers.filter((number) =>
      actualNumberSet.has(number),
    );
    const scores = scoreDraw(recommendations, target.numbers);

    results.push({
      drawDate: target.draw_date,
      trainingStartDate: trainingHistory[0].draw_date,
      trainingCutoffDate: trainingHistory.at(-1).draw_date,
      trainingDrawCount: trainingHistory.length,
      predictedNumbers,
      legacyPredictedNumbers,
      actualNumbers: [...target.numbers],
      hitNumbers,
      hitCount: hitNumbers.length,
      legacyHitNumbers,
      legacyHitCount: legacyHitNumbers.length,
      probabilities: recommendations.map(({ number, probability }) => ({
        number,
        probability,
      })),
      ...scores,
    });
  }
  return results.reverse();
}
```

扩展 `summarizeBacktest` 的空结果和非空结果，使两者都返回：

```js
{
  atLeastThreeRate,
  hitDistribution: { 0: count0, 1: count1, 2: count2, 3: count3, 4: count4, 5: count5 },
  legacyAverageHits,
}
```

空结果的 `legacyAverageHits` 为 0，`hitDistribution` 六个桶全部为 0。非空结果的 totals 初始化和归并循环必须执行：

```js
legacyHits: 0,
hitDistribution: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },

summary.atLeastThree += row.hitCount >= 3 ? 1 : 0;
summary.hitDistribution[row.hitCount] += 1;
summary.legacyHits += row.legacyHitCount;
```

最终字段计算为：

```js
atLeastThreeRate: round(
  (totals.atLeastThree / results.length) * 100,
  1,
),
hitDistribution: totals.hitDistribution,
legacyAverageHits: round(totals.legacyHits / results.length, 3),
```

- [ ] **Step 5: 运行全部模型测试**

Run:

```powershell
node --test tests/fantasy5-model.test.mjs
```

Working directory: `fantasy5-site`

Expected: PASS，0 failures。

- [ ] **Step 6: 提交回测实现**

```powershell
git add -- fantasy5-site/lib/fantasy5-model.mjs fantasy5-site/tests/fantasy5-model.test.mjs
git commit -m "feat: backtest Fantasy 5 Top 15 over 400 draws"
```

### Task 4: 用失败测试定义页面新口径与五行展示

**Files:**
- Modify: `fantasy5-site/tests/rendered-html.test.mjs`
- Test: `fantasy5-site/tests/rendered-html.test.mjs`

- [ ] **Step 1: 将旧的 10 期 Top 5 页面测试替换为统一 400 期测试**

```js
test("rendered page exposes the Top 15 fixed 400-draw backtest", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /滚动回测（最近 400 期）/);
  assert.match(html, /window\.F5_BACKTEST/);
  assert.match(html, /模型 Top 15/);
  assert.match(html, /Top 15 平均命中/);
  assert.match(html, /至少命中 3 个/);
  assert.match(html, /旧模型平均命中/);
  assert.match(html, /命中分布/);
  assert.match(html, /训练期数 400/);
  assert.doesNotMatch(html, /data-backtest-count=/);
  assert.doesNotMatch(html, /模型 Top 5/);
  assert.doesNotMatch(html, /Brier/i);
  assert.doesNotMatch(html, /Log Loss/i);
});
```

- [ ] **Step 2: 加入五行颜色和删除时支五行测试**

```js
test("rendered page color-codes element text and omits hour-branch element", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /\.element-wood\s*\{[^}]*#DCFCE7[^}]*#166534/is);
  assert.match(html, /\.element-fire\s*\{[^}]*#FEE2E2[^}]*#991B1B/is);
  assert.match(html, /\.element-earth\s*\{[^}]*#FEF3C7[^}]*#92400E/is);
  assert.match(html, /\.element-metal\s*\{[^}]*#FEF9C3[^}]*#854D0E/is);
  assert.match(html, /\.element-water\s*\{[^}]*#DBEAFE[^}]*#1E40AF/is);
  assert.match(html, /class="element-tag element-(wood|fire|earth|metal|water)"/);
  assert.doesNotMatch(html, /时支五行/);
  assert.doesNotMatch(html, /hourBranchElement/);
});
```

- [ ] **Step 3: 运行渲染测试并确认失败**

Run:

```powershell
npm.cmd run build
node --test tests/rendered-html.test.mjs
```

Working directory: `fantasy5-site`

Expected: FAIL，页面仍包含 Top 5、回测周期按钮和时支五行，且没有五行颜色类。

- [ ] **Step 4: 提交页面红灯测试**

```powershell
git add -- fantasy5-site/tests/rendered-html.test.mjs
git commit -m "test: define Fantasy 5 Top 15 page"
```

### Task 5: 接入模型并更新静态页面

**Files:**
- Modify: `fantasy5-site/scripts/build-static-worker.mjs`
- Modify: `fantasy5-site/preview.html`
- Test: `fantasy5-site/tests/rendered-html.test.mjs`

- [ ] **Step 1: 为模型构造带指标的完整历史和下一期目标**

在 `validRows` 后加入：

```js
const modelHistory = validRows.map((row) => ({
  ...row,
  ...enrichDate(row.draw_date),
}));
```

将调用改为：

```js
const recommendations = buildRecommendations(modelHistory, current);
const backtestResults = buildWalkForwardBacktest(modelHistory, {
  drawCount: 400,
});
const backtest = {
  modelVersion: MODEL_VERSION,
  drawCount: backtestResults.length,
  results: backtestResults,
  summary: summarizeBacktest(backtestResults),
};
const defaultBacktestSummary = backtest.summary;
```

删除 `requestedBacktestDrawCounts`、`availableBacktestDrawCounts`、`defaultBacktestDrawCount` 和多周期 `summaries`。

- [ ] **Step 2: 删除时支五行并加入五行标签生成器**

`enrichDate` 和 `toHistoryDisplayRow` 不再返回 `hourBranch` 或 `hourBranchElement`。在 HTML 模板生成前加入：

```js
const elementClassNames = {
  木: "wood",
  火: "fire",
  土: "earth",
  金: "metal",
  水: "water",
};

function elementTag(element) {
  const className = elementClassNames[element];
  if (!className) throw new Error(`Unknown element: ${element}`);
  return `<strong class="element-tag element-${className}">${element}</strong>`;
}
```

即将开奖指标条使用：

```html
<div class="indicator"><span>日五行</span>${elementTag(current.dayElement)}</div>
<div class="indicator"><span>时干五行</span>${elementTag(current.hourStemElement)}</div>
```

删除“时支五行”指标块、历史表头及 `appendCell(row, rowData.hourBranchElement)`。

- [ ] **Step 3: 添加固定五行颜色和客户端表格标签**

CSS 加入：

```css
.element-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2em;
  border-radius: 999px;
  padding: 2px 8px;
  font-weight: 800;
}
.element-wood { background: #DCFCE7; color: #166534; }
.element-fire { background: #FEE2E2; color: #991B1B; }
.element-earth { background: #FEF3C7; color: #92400E; }
.element-metal { background: #FEF9C3; color: #854D0E; }
.element-water { background: #DBEAFE; color: #1E40AF; }
```

客户端加入：

```js
const elementClassNames = {
  木: "wood",
  火: "fire",
  土: "earth",
  金: "metal",
  水: "water",
};

function appendElementCell(row, element) {
  const cell = document.createElement("td");
  const tag = document.createElement("span");
  tag.className = "element-tag element-" + elementClassNames[element];
  tag.textContent = element;
  cell.appendChild(tag);
  row.appendChild(cell);
  return cell;
}
```

`renderRow` 中将日五行和时干五行的 `appendCell` 改为 `appendElementCell`。

- [ ] **Step 4: 将推荐和回测文案统一为 Top 15 / 400 期**

执行以下确定性修改：

- 推荐球的重点范围从 `index < 5` 改为 `index < 15`；
- 回测标题固定为“滚动回测（最近 400 期）”；
- 删除 `.backtest-controls`、回测周期按钮及对应事件监听；
- 将所有“模型 Top 5”及“Top 5 平均命中”改为 Top 15；
- 增加“至少命中 3 个”指标，绑定 `summary.atLeastThreeRate`；
- 页面展示随机平均命中基线 `75 / 39`；
- 页面展示同一批 400 个目标期、同为 Top 15 的 `summary.legacyAverageHits`；
- 页面以“命中分布 0:x / 1:x / 2:x / 3:x / 4:x / 5:x”展示 `summary.hitDistribution`；
- 删除回测结果、汇总卡片和逐期表格中的 Brier Score 与 Log Loss；
- 表格增加训练起始日期列并继续展示训练截止日期；
- 防穿越说明改为“每一期仅使用此前最近 400 期”；
- 删除“时支固定酉，五行固定金”提示；
- 免责声明继续明确不保证预测或中奖。

客户端初始化改为直接渲染单一结果：

```js
function renderBacktest() {
  const summary = backtestData.summary;
  backtestMetricEls.averageHits.textContent = summary.averageHits.toFixed(2);
  backtestMetricEls.oneRate.textContent = summary.atLeastOneRate.toFixed(1) + "%";
  backtestMetricEls.twoRate.textContent = summary.atLeastTwoRate.toFixed(1) + "%";
  backtestMetricEls.threeRate.textContent =
    summary.atLeastThreeRate.toFixed(1) + "%";
  backtestMetricEls.legacyAverageHits.textContent =
    summary.legacyAverageHits.toFixed(2);
  backtestMetricEls.hitDistribution.textContent = [0, 1, 2, 3, 4, 5]
    .map((count) => count + ":" + summary.hitDistribution[String(count)])
    .join(" / ");
  backtestBody.innerHTML = "";
  backtestData.results.forEach((result) => {
    const row = document.createElement("tr");
    row.dataset.backtestRow = "true";
    appendCell(row, result.drawDate);
    appendCell(row, result.trainingStartDate);
    appendCell(row, result.trainingCutoffDate);
    appendCell(row, result.trainingDrawCount);
    appendNumberCell(row, result.predictedNumbers, result.hitNumbers);
    appendNumberCell(row, result.actualNumbers, result.hitNumbers);
    appendNumberCell(row, result.hitNumbers, result.hitNumbers);
    const hitCell = document.createElement("td");
    const hitCount = document.createElement("strong");
    hitCount.className =
      "hit-count" + (result.hitCount > 0 ? " has-hit" : "");
    hitCount.textContent = String(result.hitCount);
    hitCell.appendChild(hitCount);
    row.appendChild(hitCell);
    backtestBody.appendChild(row);
  });
}
```

- [ ] **Step 5: 构建并运行渲染测试**

Run:

```powershell
npm.cmd run build
node --test tests/rendered-html.test.mjs
```

Working directory: `fantasy5-site`

Expected: PASS，0 failures；`preview.html` 和 `dist` 由同一次构建生成。

- [ ] **Step 6: 提交构建和页面变更**

先用 `git status --short` 确认只选择直接相关文件，再执行：

```powershell
git add -- fantasy5-site/scripts/build-static-worker.mjs fantasy5-site/tests/rendered-html.test.mjs fantasy5-site/preview.html
git commit -m "feat: publish Fantasy 5 Top 15 research view"
```

如果 `dist` 已被版本控制，再将其实际已跟踪变更加入同一提交；不得使用通配符加入 `docs/superpowers` 下既有无关文件。

### Task 6: 完整验证、回测审计和精确提交

**Files:**
- Verify: `fantasy5-site/lib/fantasy5-model.mjs`
- Verify: `fantasy5-site/scripts/build-static-worker.mjs`
- Verify: `fantasy5-site/tests/fantasy5-model.test.mjs`
- Verify: `fantasy5-site/tests/rendered-html.test.mjs`
- Verify: `fantasy5-site/preview.html`

- [ ] **Step 1: 运行完整测试**

Run:

```powershell
npm.cmd test
```

Working directory: `fantasy5-site`

Expected: exit code 0，所有测试 PASS。

- [ ] **Step 2: 审计构建嵌入的回测数据**

Run:

```powershell
node -e "const fs=require('fs');const h=fs.readFileSync('preview.html','utf8');const m=h.match(/window\\.F5_BACKTEST = (\\{.*?\\});/s);if(!m)throw new Error('missing backtest');const b=JSON.parse(m[1]);if(b.results.length!==400)throw new Error('expected 400 results');if(b.results.some(r=>r.trainingDrawCount!==400||r.predictedNumbers.length!==15||r.legacyPredictedNumbers.length!==15))throw new Error('invalid window or Top 15');console.log(JSON.stringify({modelVersion:b.modelVersion,drawCount:b.results.length,averageHits:b.summary.averageHits,legacyAverageHits:b.summary.legacyAverageHits,atLeastOneRate:b.summary.atLeastOneRate,atLeastTwoRate:b.summary.atLeastTwoRate,atLeastThreeRate:b.summary.atLeastThreeRate,baseline:b.summary.randomBaselineAverageHits},null,2));"
```

Working directory: `fantasy5-site`

Expected: 打印模型版本、`drawCount: 400`、真实平均命中及命中率，且 `baseline` 约为 `1.923076923`。无论提升为正或负都如实保留。

- [ ] **Step 3: 检查范围和工作树**

Run:

```powershell
git diff --check
git status --short
git diff --stat ad5c7f9..HEAD
```

Expected: 无空白错误；既有两个无关未跟踪文档仍未被提交；提交范围只覆盖设计、计划、模型、测试、构建脚本和必要构建产物。

- [ ] **Step 4: 如验证产生必要的跟踪构建产物，单独提交**

仅当 `npm.cmd test` 重新生成了直接相关且已跟踪的文件时执行：

```powershell
git add -- fantasy5-site/preview.html
git commit -m "build: refresh Fantasy 5 dynamic model page"
```

如果没有跟踪变更，跳过此提交。

### Task 7: 推送同一提交并私有发布既有 Sites 项目

**Files:**
- Read: `fantasy5-site/.openai/hosting.json`
- Package: `fantasy5-site/dist/`
- Do not modify: Sites project access control or domain configuration

- [ ] **Step 1: 读取 Sites 托管技能并确认项目 ID**

执行阶段先完整读取 `sites:sites-hosting` 技能。再次读取：

```powershell
Get-Content -Raw .openai/hosting.json
```

Working directory: `fantasy5-site`

Expected: `project_id` 必须仍为 `appgprj_6a5db91b91a081919ef50a3358cd12ff`。不得调用创建站点工具。

- [ ] **Step 2: 记录并推送经过测试的精确提交**

Run:

```powershell
git rev-parse HEAD
git status --short
git push
```

Expected: 记录一个确定的 `commit_sha`；只允许两个既有无关未跟踪文档存在，不能有未提交的 Fantasy 5 文件。推送成功后远端必须包含同一 SHA。

- [ ] **Step 3: 取得短期源码写入凭据并推送相同源码状态**

使用 Sites 工具为既有项目获取短期源码写入凭据，并将 `commit_sha` 对应的精确源码状态推送到其源码存储。不得重新构建或混入工作树未提交文件。

Expected: Sites 接受该提交，返回可用于保存版本的源码状态；项目 ID 不变。

- [ ] **Step 4: 从相同提交打包 dist 并保存版本**

从 `commit_sha` 对应的 `fantasy5-site/dist` 创建发布归档，保存为既有项目的新版本。版本元数据中的 `commit_sha` 必须与 Step 2 相同。

Expected: 返回新版本 ID；不得更改访问权限、域名或创建项目。

- [ ] **Step 5: 私有发布并轮询到成功**

仅部署 Step 4 保存的版本，保持当前私有访问模式。初始状态非终态时，每次轮询不超过 60 秒，直到成功或明确失败。

Expected: 发布状态为成功，线上地址仍为既有 Sites 地址；若 `gpt.lucktime.net/5` 因私有上游要求 ChatGPT 登录，报告该限制，不擅自公开站点。

- [ ] **Step 6: 验证线上版本并报告**

验证线上 HTML 包含：

- `F5-EB-TIME400-TOP15-v2`
- “模型 Top 15”
- “滚动回测（最近 400 期）”
- 五种五行颜色类
- 不包含“时支五行”
- 不包含 Brier Score 或 Log Loss

最终报告：

- 数据截止日期；
- 400 期回测平均命中数和至少命中 1、2、3 个的比例；
- 是否高于随机平均基线 `75 / 39`；
- 已发布版本和线上地址；
- `gpt.lucktime.net/5` 的当前认证限制；
- 明确说明模型不能保证预测或中奖。
