import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLotteryCornerFantasy5Rows,
  syncFantasy5History,
} from "../lib/fantasy5-sync.mjs";

test("parseLotteryCornerFantasy5Rows extracts draw date, five numbers, and jackpot", () => {
  const html = `
    <table>
      <tr><td>Jul 18, 2026</td><td>4 8 15 16 23</td><td>$98,000</td></tr>
      <tr><td>Jul 17, 2026</td><td>1 3 5 7 39</td><td>$74,000</td></tr>
    </table>`;

  const rows = parseLotteryCornerFantasy5Rows(
    html,
    "https://www.lotterycorner.com/ca/fantasy-5/2026",
  );

  assert.deepEqual(
    rows.map((row) => row.draw_date),
    ["2026-07-18", "2026-07-17"],
  );
  assert.deepEqual(rows[0].numbers, [4, 8, 15, 16, 23]);
  assert.equal(rows[0].jackpot_amount, 98000);
  assert.equal(rows[0].rule_version, "FANTASY5_5_OF_39");
});

test("syncFantasy5History merges fetched rows without writing during dry run", async () => {
  let wrote = false;
  const result = await syncFantasy5History({
    csvText:
      'draw_date,weekday,number_1,number_2,number_3,number_4,number_5,jackpot_text,jackpot_amount,rule_version,source_url\n2026-07-17,Friday,1,3,5,7,39,"$74,000",74000,FANTASY5_5_OF_39,old\n',
    fetchText: async () =>
      "<tr><td>Jul 18, 2026</td><td>4 8 15 16 23</td><td>$98,000</td></tr>",
    writeCsvText: async () => {
      wrote = true;
    },
    sourceUrls: ["https://www.lotterycorner.com/ca/fantasy-5/2026"],
    dryRun: true,
  });

  assert.equal(wrote, false);
  assert.equal(result.added, 1);
  assert.equal(result.latestDate, "2026-07-18");
  assert.equal(result.checked, 1);
});
