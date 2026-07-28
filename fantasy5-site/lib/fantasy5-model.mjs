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

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function logit(probability) {
  const safe = clamp(probability, SCORE_EPSILON, 1 - SCORE_EPSILON);
  return Math.log(safe / (1 - safe));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

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
    throw new Error("buildRecommendations requires 400 training draws");
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
    const cappedIndexes = [];
    for (const index of remainingIndexes) {
      const probability =
        (items[index].rawWeight / weightSum) * remainingMass;
      if (probability >= 1 - SCORE_EPSILON) {
        probabilities[index] = 1 - SCORE_EPSILON;
        remainingMass -= probabilities[index];
        cappedIndexes.push(index);
      } else {
        probabilities[index] = probability;
      }
    }
    if (cappedIndexes.length === 0) break;
    remainingIndexes = remainingIndexes.filter(
      (index) => !cappedIndexes.includes(index),
    );
  }

  const mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (!Number.isFinite(mass) || Math.abs(mass - targetMass) > 1e-6) {
    throw new Error("probability normalization failed");
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
    });
  }

  return results.reverse();
}

export function summarizeBacktest(results) {
  const emptyDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (results.length === 0) {
    return {
      drawCount: 0,
      averageHits: 0,
      legacyAverageHits: 0,
      atLeastOneRate: 0,
      atLeastTwoRate: 0,
      atLeastThreeRate: 0,
      hitDistribution: emptyDistribution,
      randomBaselineAverageHits: BASELINE_AVERAGE_HITS,
      averageHitLift: round(-BASELINE_AVERAGE_HITS, 3),
    };
  }

  const totals = results.reduce(
    (summary, row) => {
      summary.hits += row.hitCount;
      summary.legacyHits += row.legacyHitCount;
      summary.atLeastOne += row.hitCount >= 1 ? 1 : 0;
      summary.atLeastTwo += row.hitCount >= 2 ? 1 : 0;
      summary.atLeastThree += row.hitCount >= 3 ? 1 : 0;
      summary.hitDistribution[row.hitCount] += 1;
      return summary;
    },
    {
      hits: 0,
      legacyHits: 0,
      atLeastOne: 0,
      atLeastTwo: 0,
      atLeastThree: 0,
      hitDistribution: { ...emptyDistribution },
    },
  );
  const averageHits = totals.hits / results.length;

  return {
    drawCount: results.length,
    averageHits: round(averageHits, 3),
    legacyAverageHits: round(totals.legacyHits / results.length, 3),
    atLeastOneRate: round((totals.atLeastOne / results.length) * 100, 1),
    atLeastTwoRate: round((totals.atLeastTwo / results.length) * 100, 1),
    atLeastThreeRate: round(
      (totals.atLeastThree / results.length) * 100,
      1,
    ),
    hitDistribution: totals.hitDistribution,
    randomBaselineAverageHits: BASELINE_AVERAGE_HITS,
    averageHitLift: round(averageHits - BASELINE_AVERAGE_HITS, 3),
  };
}
