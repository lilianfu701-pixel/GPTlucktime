import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeHistoryRows,
  parseHistoryCsv,
  serializeHistoryCsv,
  validateHistoryRow,
} from "../lib/history-data.mjs";

const header =
  "draw_date,weekday,number_1,number_2,number_3,number_4,number_5,jackpot_text,jackpot_amount,rule_version,source_url";

test("validateHistoryRow accepts five distinct Fantasy 5 numbers from 1 to 39", () => {
  const row = validateHistoryRow({
    draw_date: "2026-07-17",
    weekday: "Friday",
    number_1: "1",
    number_2: "9",
    number_3: "18",
    number_4: "27",
    number_5: "39",
    jackpot_text: "$220,000",
    jackpot_amount: "220000",
    rule_version: "FANTASY5_5_OF_39",
    source_url: "https://www.lotterycorner.com/ca/fantasy-5/2026",
  });

  assert.deepEqual(row.numbers, [1, 9, 18, 27, 39]);
  assert.equal(row.draw_date, "2026-07-17");
  assert.equal(row.jackpot_amount, 220000);
});

test("validateHistoryRow rejects out-of-range and duplicate numbers", () => {
  assert.throws(
    () =>
      validateHistoryRow({
        draw_date: "2026-07-17",
        number_1: "1",
        number_2: "1",
        number_3: "18",
        number_4: "27",
        number_5: "39",
        rule_version: "FANTASY5_5_OF_39",
      }),
    /duplicate/i,
  );

  assert.throws(
    () =>
      validateHistoryRow({
        draw_date: "2026-07-17",
        number_1: "0",
        number_2: "9",
        number_3: "18",
        number_4: "27",
        number_5: "39",
        rule_version: "FANTASY5_5_OF_39",
      }),
    /1-39/i,
  );
});

test("mergeHistoryRows replaces duplicate dates, sorts ascending, and serializes stable CSV", () => {
  const existing = parseHistoryCsv(
    `${header}\n2026-07-17,Friday,1,2,3,4,5,"$100,000",100000,FANTASY5_5_OF_39,old\n`,
  );
  const merged = mergeHistoryRows(existing, [
    validateHistoryRow({
      draw_date: "2026-07-17",
      weekday: "Friday",
      number_1: "6",
      number_2: "7",
      number_3: "8",
      number_4: "9",
      number_5: "10",
      jackpot_text: "$200,000",
      jackpot_amount: "200000",
      rule_version: "FANTASY5_5_OF_39",
      source_url: "new",
    }),
    validateHistoryRow({
      draw_date: "2026-07-18",
      weekday: "Saturday",
      number_1: "11",
      number_2: "12",
      number_3: "13",
      number_4: "14",
      number_5: "15",
      jackpot_text: "$300,000",
      jackpot_amount: "300000",
      rule_version: "FANTASY5_5_OF_39",
      source_url: "new",
    }),
  ]);

  assert.deepEqual(
    merged.map((row) => row.draw_date),
    ["2026-07-17", "2026-07-18"],
  );
  assert.deepEqual(merged[0].numbers, [6, 7, 8, 9, 10]);
  assert.match(serializeHistoryCsv(merged), /^draw_date,weekday,number_1/);
  assert.match(serializeHistoryCsv(merged), /"\$200,000"/);
});
