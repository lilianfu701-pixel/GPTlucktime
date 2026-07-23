import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/5") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`));
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
