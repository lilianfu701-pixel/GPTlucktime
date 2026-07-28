import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/5") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`));
}

function embeddedJson(html, variableName) {
  const match = html.match(
    new RegExp(`window\\.${variableName} = (.*);`),
  );
  assert.ok(match, `missing ${variableName}`);
  return JSON.parse(match[1]);
}

test("rendered page shows data cutoff, freshness status, and jackpot placement", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Fantasy 5 深度推演研究台/);
  assert.match(html, /数据截止日期/);
  assert.match(html, /历史数据(已更新|未更新)/);
  assert.match(html, /window\.F5_DATA_STATUS/);
  assert.match(html, /当前奖池/);
  assert.match(html, /<span class="jackpot-highlight">\$[\d,]+<\/span>/);
  assert.doesNotMatch(html, /奖池<\/th>/);
});

test("worker redirects unknown paths back to the Fantasy 5 page", async () => {
  const response = await render("/anything-else");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://localhost/5");
});

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
  assert.match(html, /id="backtest-body"/);
  assert.match(html, /<a class="tab" href="#backtest-panel">回测<\/a>/);
  assert.match(html, /严禁未来数据参与/);
  assert.doesNotMatch(html, /data-backtest-count=/);
  assert.doesNotMatch(html, /模型 Top 5/);
  assert.doesNotMatch(html, /Brier/i);
  assert.doesNotMatch(html, /Log Loss/i);
});

test("rendered page color-codes element text and omits hour-branch element", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /\.element-wood\s*\{[^}]*#DCFCE7[^}]*#166534/is);
  assert.match(html, /\.element-fire\s*\{[^}]*#FEE2E2[^}]*#991B1B/is);
  assert.match(html, /\.element-earth\s*\{[^}]*#FEF3C7[^}]*#92400E/is);
  assert.match(html, /\.element-metal\s*\{[^}]*#FEF9C3[^}]*#854D0E/is);
  assert.match(html, /\.element-water\s*\{[^}]*#DBEAFE[^}]*#1E40AF/is);
  assert.match(
    html,
    /class="element-tag element-(wood|fire|earth|metal|water)"/,
  );
  assert.doesNotMatch(html, /时支五行/);
  assert.doesNotMatch(html, /hourBranchElement/);
});

test("current 400-draw audit reports legacy comparison and varied picks", async () => {
  const response = await render();
  const html = await response.text();
  const backtest = embeddedJson(html, "F5_BACKTEST");
  const distinctPicks = new Set(
    backtest.results.map((row) => row.predictedNumbers.join(",")),
  );

  assert.equal(backtest.results.length, 400);
  assert.ok(distinctPicks.size > 1);
  assert.ok(Number.isFinite(backtest.summary.averageHits));
  assert.ok(Number.isFinite(backtest.summary.legacyAverageHits));
  assert.ok(Number.isFinite(backtest.summary.randomBaselineAverageHits));
});
