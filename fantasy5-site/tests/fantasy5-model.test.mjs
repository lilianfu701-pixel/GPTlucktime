import assert from "node:assert/strict";
import test from "node:test";
import * as model from "../lib/fantasy5-model.mjs";

const {
  BASELINE_AVERAGE_HITS,
  MODEL_VERSION,
  RECOMMENDATION_COUNT,
  TRAINING_DRAW_COUNT,
  buildRecommendations,
  buildWalkForwardBacktest,
  summarizeBacktest,
} = model;

const DAY_MS = 24 * 60 * 60 * 1000;
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const branches = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const elementByStem = {
  甲: "木",
  乙: "木",
  丙: "火",
  丁: "火",
  戊: "土",
  己: "土",
  庚: "金",
  辛: "金",
  壬: "水",
  癸: "水",
};

function dateAt(index) {
  return new Date(Date.UTC(2024, 0, 1) + index * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

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

test("buildRecommendations requires 400 draws and returns a deterministic Top 15 ranking", () => {
  const history = Array.from({ length: 400 }, (_, index) => historyRow(index));
  const target = indicatorsAt(401);

  assert.throws(
    () => buildRecommendations(history.slice(1), target),
    /400 training draws/,
  );

  const first = buildRecommendations(history, target);
  const second = buildRecommendations(history, target);

  assert.deepEqual(second, first);
  assert.equal(TRAINING_DRAW_COUNT, 400);
  assert.equal(RECOMMENDATION_COUNT, 15);
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
  const history = Array.from({ length: 400 }, (_, index) =>
    historyRow(index, {
      numbers: index % 2 === 0 ? [1, 2, 3, 4, 5] : [35, 36, 37, 38, 39],
      weekday: index % 2 === 0 ? "周一" : "周二",
      dayStem: index % 2 === 0 ? "甲" : "庚",
      dayElement: index % 2 === 0 ? "木" : "金",
    }),
  );
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
  assert.ok(
    first.every(
      (row) =>
        !Object.hasOwn(row, "brierScore") && !Object.hasOwn(row, "logLoss"),
    ),
  );

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

test("summarizeBacktest reports Top 15 hit rates, distribution, and legacy comparison", () => {
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
    0: 1,
    1: 1,
    2: 1,
    3: 1,
    4: 0,
    5: 0,
  });
  assert.equal(summary.legacyAverageHits, 1);
  assert.equal(BASELINE_AVERAGE_HITS, 75 / 39);
  assert.equal(summary.randomBaselineAverageHits, BASELINE_AVERAGE_HITS);
  assert.equal(
    summary.averageHitLift,
    Number((1.5 - BASELINE_AVERAGE_HITS).toFixed(3)),
  );
  assert.ok(!Object.hasOwn(summary, "brierScore"));
  assert.ok(!Object.hasOwn(summary, "logLoss"));
});
