export const BASELINE_PROBABILITY = 5 / 39;
export const BASELINE_AVERAGE_HITS = 25 / 39;
export const MODEL_VERSION = "F5-EB-FREQ-v1";

const PRIOR_DRAWS = 90;
const SCORE_EPSILON = 1e-9;

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildRecommendations(history) {
  const counts = new Array(40).fill(0);

  history.forEach((row) => {
    row.numbers.forEach((number) => {
      counts[number] += 1;
    });
  });

  return Array.from({ length: 39 }, (_, index) => {
    const number = index + 1;
    const count = counts[number];
    const probability =
      ((count + BASELINE_PROBABILITY * PRIOR_DRAWS) /
        (history.length + PRIOR_DRAWS)) *
      100;

    return {
      number,
      probability: round(probability, 6),
      count,
    };
  }).sort(
    (left, right) =>
      right.probability - left.probability || left.number - right.number,
  );
}

function scoreDraw(recommendations, actualNumbers) {
  const outcomes = new Set(actualNumbers);
  let brierTotal = 0;
  let logLossTotal = 0;

  recommendations.forEach((item) => {
    const outcome = outcomes.has(item.number) ? 1 : 0;
    const probability = clamp(
      item.probability / 100,
      SCORE_EPSILON,
      1 - SCORE_EPSILON,
    );
    brierTotal += (probability - outcome) ** 2;
    logLossTotal +=
      -(outcome * Math.log(probability) +
        (1 - outcome) * Math.log(1 - probability));
  });

  return {
    brierScore: round(brierTotal / 39, 6),
    logLoss: round(logLossTotal / 39, 6),
  };
}

export function buildWalkForwardBacktest(
  history,
  { drawCount = 50, minTrainingDraws = 365 } = {},
) {
  if (!Number.isInteger(drawCount) || drawCount < 1) {
    throw new Error("drawCount must be a positive integer");
  }
  if (!Number.isInteger(minTrainingDraws) || minTrainingDraws < 1) {
    throw new Error("minTrainingDraws must be a positive integer");
  }

  const chronologicalHistory = [...history].sort((left, right) =>
    left.draw_date.localeCompare(right.draw_date),
  );
  const firstTargetIndex = Math.max(
    minTrainingDraws,
    chronologicalHistory.length - drawCount,
  );
  const results = [];

  for (
    let targetIndex = firstTargetIndex;
    targetIndex < chronologicalHistory.length;
    targetIndex += 1
  ) {
    const trainingHistory = chronologicalHistory.slice(0, targetIndex);
    const target = chronologicalHistory[targetIndex];
    const recommendations = buildRecommendations(trainingHistory);
    const predictedNumbers = recommendations
      .slice(0, 5)
      .map((item) => item.number);
    const actualNumberSet = new Set(target.numbers);
    const hitNumbers = predictedNumbers.filter((number) =>
      actualNumberSet.has(number),
    );
    const scores = scoreDraw(recommendations, target.numbers);

    results.push({
      drawDate: target.draw_date,
      trainingCutoffDate: chronologicalHistory[targetIndex - 1].draw_date,
      trainingDrawCount: trainingHistory.length,
      predictedNumbers,
      actualNumbers: [...target.numbers],
      hitNumbers,
      hitCount: hitNumbers.length,
      probabilities: recommendations.map(({ number, probability }) => ({
        number,
        probability,
      })),
      ...scores,
    });
  }

  return results.reverse();
}

export function summarizeBacktest(results) {
  if (results.length === 0) {
    return {
      drawCount: 0,
      averageHits: 0,
      atLeastOneRate: 0,
      atLeastTwoRate: 0,
      brierScore: 0,
      logLoss: 0,
      randomBaselineAverageHits: BASELINE_AVERAGE_HITS,
      averageHitLift: round(-BASELINE_AVERAGE_HITS, 3),
    };
  }

  const totals = results.reduce(
    (summary, row) => {
      summary.hits += row.hitCount;
      summary.atLeastOne += row.hitCount >= 1 ? 1 : 0;
      summary.atLeastTwo += row.hitCount >= 2 ? 1 : 0;
      summary.brier += row.brierScore;
      summary.logLoss += row.logLoss;
      return summary;
    },
    {
      hits: 0,
      atLeastOne: 0,
      atLeastTwo: 0,
      brier: 0,
      logLoss: 0,
    },
  );
  const averageHits = totals.hits / results.length;

  return {
    drawCount: results.length,
    averageHits: round(averageHits, 3),
    atLeastOneRate: round((totals.atLeastOne / results.length) * 100, 1),
    atLeastTwoRate: round((totals.atLeastTwo / results.length) * 100, 1),
    brierScore: round(totals.brier / results.length, 6),
    logLoss: round(totals.logLoss / results.length, 6),
    randomBaselineAverageHits: BASELINE_AVERAGE_HITS,
    averageHitLift: round(averageHits - BASELINE_AVERAGE_HITS, 3),
  };
}
