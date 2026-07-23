import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_AVERAGE_HITS,
  MODEL_VERSION,
  buildRecommendations,
  buildWalkForwardBacktest,
  summarizeBacktest,
} from "../lib/fantasy5-model.mjs";

function dateAt(index) {
  const date = new Date(Date.UTC(2026, 0, index + 1));
  return date.toISOString().slice(0, 10);
}

function historyRow(index) {
  return {
    draw_date: dateAt(index),
    numbers: Array.from({ length: 5 }, (_, offset) => ((index * 3 + offset * 7) % 39) + 1),
  };
}

test("buildRecommendations returns 39 ranked marginal probabilities that sum to five", () => {
  const recommendations = buildRecommendations(Array.from({ length: 12 }, (_, index) => historyRow(index)));

  assert.equal(recommendations.length, 39);
  assert.deepEqual(
    new Set(recommendations.map((item) => item.number)).size,
    39,
  );
  assert.ok(
    recommendations.every(
      (item, index) =>
        item.probability > 0 &&
        item.probability < 100 &&
        (index === 0 || recommendations[index - 1].probability >= item.probability),
    ),
  );

  const probabilityMass = recommendations.reduce((total, item) => total + item.probability, 0);
  assert.ok(Math.abs(probabilityMass - 500) < 0.05);
});

test("walk-forward backtest evaluates at least 10 draws without using target or future results", () => {
  const history = Array.from({ length: 16 }, (_, index) => historyRow(index));
  const firstRun = buildWalkForwardBacktest(history, {
    drawCount: 10,
    minTrainingDraws: 3,
  });

  assert.equal(firstRun.length, 10);
  assert.ok(firstRun.every((row) => row.trainingCutoffDate < row.drawDate));
  assert.ok(firstRun.every((row) => row.predictedNumbers.length === 5));
  assert.ok(firstRun.every((row) => row.probabilities.length === 39));
  assert.ok(firstRun.every((row) => Number.isFinite(row.brierScore)));
  assert.ok(firstRun.every((row) => Number.isFinite(row.logLoss)));

  const changedFuture = history.map((row) => ({ ...row, numbers: [...row.numbers] }));
  changedFuture.at(-1).numbers = [35, 36, 37, 38, 39];
  const secondRun = buildWalkForwardBacktest(changedFuture, {
    drawCount: 10,
    minTrainingDraws: 3,
  });

  assert.deepEqual(
    secondRun.map((row) => row.predictedNumbers),
    firstRun.map((row) => row.predictedNumbers),
  );
});

test("walk-forward backtest normalizes input into chronological draw order", () => {
  const chronological = Array.from({ length: 8 }, (_, index) => historyRow(index));
  const shuffled = [
    chronological[4],
    chronological[0],
    chronological[7],
    chronological[2],
    chronological[6],
    chronological[1],
    chronological[5],
    chronological[3],
  ];

  const results = buildWalkForwardBacktest(shuffled, {
    drawCount: 3,
    minTrainingDraws: 3,
  });

  assert.deepEqual(
    results.map((row) => row.drawDate),
    [dateAt(7), dateAt(6), dateAt(5)],
  );
  assert.deepEqual(
    results.map((row) => row.trainingCutoffDate),
    [dateAt(6), dateAt(5), dateAt(4)],
  );
});

test("summarizeBacktest reports hit rates, proper scores, and random-baseline lift", () => {
  const results = [
    { hitCount: 0, brierScore: 0.12, logLoss: 0.39 },
    { hitCount: 1, brierScore: 0.11, logLoss: 0.37 },
    { hitCount: 2, brierScore: 0.1, logLoss: 0.35 },
    { hitCount: 1, brierScore: 0.09, logLoss: 0.33 },
  ];

  const summary = summarizeBacktest(results);

  assert.equal(MODEL_VERSION, "F5-EB-FREQ-v1");
  assert.equal(summary.drawCount, 4);
  assert.equal(summary.averageHits, 1);
  assert.equal(summary.atLeastOneRate, 75);
  assert.equal(summary.atLeastTwoRate, 25);
  assert.equal(summary.brierScore, 0.105);
  assert.equal(summary.logLoss, 0.36);
  assert.equal(summary.randomBaselineAverageHits, BASELINE_AVERAGE_HITS);
  assert.equal(
    summary.averageHitLift,
    Number((1 - BASELINE_AVERAGE_HITS).toFixed(3)),
  );
});
