import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HISTORY_CSV_PATH, parseHistoryCsv } from "../lib/history-data.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const csvPath = HISTORY_CSV_PATH;
const outputPath = resolve(projectRoot, "dist/server/index.js");
const previewPath = resolve(projectRoot, "preview.html");

const stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const branches = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const elementByStem = {
  "甲": "木",
  "乙": "木",
  "丙": "火",
  "丁": "火",
  "戊": "土",
  "己": "土",
  "庚": "金",
  "辛": "金",
  "壬": "水",
  "癸": "水",
};

const anchor = {
  date: "2026-07-19",
  stemIndex: 0,
  branchIndex: 6,
  issue: 9695,
  time: "18:25",
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [rawHeaders, ...values] = rows.filter((item) => item.some(Boolean));
  const headers = rawHeaders.map((header) => header.replace(/^\uFEFF/, "").trim());
  return values.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ""])));
}

function toUtcDay(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

function daysBetween(dateText, anchorDate) {
  return Math.round(toUtcDay(dateText) - toUtcDay(anchorDate));
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function losAngelesDateText(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Los_Angeles",
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function positiveModulo(value, mod) {
  return ((value % mod) + mod) % mod;
}

function enrichDate(dateText) {
  const diff = daysBetween(dateText, anchor.date);
  const stem = stems[positiveModulo(anchor.stemIndex + diff, 10)];
  const branch = branches[positiveModulo(anchor.branchIndex + diff, 12)];
  const startStemIndex = (positiveModulo(anchor.stemIndex + diff, 5) * 2) % 10;
  const hourStem = stems[(startStemIndex + 9) % 10];
  const date = new Date(`${dateText}T12:00:00-07:00`);

  return {
    weekday: weekdays[date.getDay()],
    tail: Number(dateText.slice(-2)) % 10,
    dayStem: stem,
    dayBranch: branch,
    dayElement: elementByStem[stem],
    hourStem,
    hourStemElement: elementByStem[hourStem],
    hourBranch: "酉",
    hourBranchElement: "金",
    issue: anchor.issue + diff,
  };
}

function readValidHistoryRows() {
  if (!existsSync(csvPath)) {
    return [];
  }

  return parseHistoryCsv(readFileSync(csvPath, "utf8"));
}

function toHistoryDisplayRow(row) {
      const enriched = enrichDate(row.draw_date);
      return {
        date: row.draw_date,
        issue: enriched.issue,
        weekday: enriched.weekday,
        tail: enriched.tail,
        dayStem: enriched.dayStem,
        dayBranch: enriched.dayBranch,
        dayElement: enriched.dayElement,
        hourStem: enriched.hourStem,
        hourStemElement: enriched.hourStemElement,
        hourBranch: enriched.hourBranch,
        hourBranchElement: enriched.hourBranchElement,
    numbers: row.numbers,
      };
}

function buildDataStatus(validRows, visibleHistory) {
  const latestRow = validRows.at(-1);
  const latestDate = latestRow?.draw_date ?? null;
  const todayLa = losAngelesDateText();
  const daysBehind = latestDate ? daysBetween(todayLa, latestDate) : null;
  const isStale = daysBehind === null || daysBehind > 2;

  return {
    latestDate,
    todayLa,
    daysBehind,
    isStale,
    statusText: isStale ? "历史数据未更新" : "历史数据已更新",
    totalRows: validRows.length,
    visibleRows: visibleHistory.length,
    csvPath,
    builtAt: new Date().toISOString(),
  };
}

function buildRecommendations(history) {
  const baseline = 5 / 39;
  const prior = 90;
  const sampleSize = Math.max(history.length, 1);
  const counts = new Map(Array.from({ length: 39 }, (_, index) => [index + 1, 0]));

  history.forEach((row) => {
    row.numbers.forEach((number) => counts.set(number, (counts.get(number) ?? 0) + 1));
  });

  return Array.from({ length: 39 }, (_, index) => {
    const number = index + 1;
    const count = counts.get(number) ?? 0;
    const probability = ((count + baseline * prior) / (sampleSize + prior)) * 100;
    return { number, probability: Number(probability.toFixed(1)), count };
  }).sort((left, right) => right.probability - left.probability || left.number - right.number);
}

const validRows = readValidHistoryRows();
const history = validRows.slice(-300).reverse().map(toHistoryDisplayRow);
const latestRow = validRows.at(-1);
const nextDrawDate = latestRow ? addDays(latestRow.draw_date, 1) : anchor.date;
const dataStatus = buildDataStatus(validRows, history);
const current = {
  date: nextDrawDate,
  time: anchor.time,
  jackpot: latestRow?.jackpot_text || "待同步",
  ...enrichDate(nextDrawDate),
};
const recommendations = buildRecommendations(history);

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fantasy 5 深度推演研究台</title>
  <style>
    :root {
      --bg: #f5f1e8;
      --surface: #fffdf8;
      --ink: #17202a;
      --muted: #667085;
      --line: #ddd6c8;
      --soft: #f7f8fa;
      --blue: #2563eb;
      --blue-soft: #dbeafe;
      --green: #17734d;
      --selected: #e11d48;
      --shadow: 0 10px 26px rgba(23, 32, 42, 0.07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
    }
    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 18px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 4px; font-size: 28px; letter-spacing: 0; }
    h2 { margin-bottom: 10px; font-size: 18px; }
    h3 { margin-bottom: 8px; font-size: 14px; }
    p { color: var(--muted); line-height: 1.55; }
    button, input, select { font: inherit; }
    .top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      margin-bottom: 12px;
    }
    .subtitle { margin-bottom: 8px; color: var(--muted); }
    .pills { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill {
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: 999px;
      padding: 5px 9px;
      color: #344054;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.blue { background: var(--blue-soft); border-color: #bfdbfe; color: #1d4ed8; }
    .pill.green { background: #dcf6e9; border-color: #a5dfc1; color: #145f3f; }
    .pill.warn { background: #fff1d6; border-color: #f6c56d; color: #8a4b0f; }
    .rollback {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .btn {
      height: 34px;
      border: 1px solid var(--line);
      background: white;
      border-radius: 6px;
      padding: 0 10px;
      color: #344054;
      font-size: 13px;
      cursor: pointer;
    }
    .btn.active { border-color: var(--blue); background: var(--blue); color: white; }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .next-draw {
      display: grid;
      grid-template-columns: minmax(280px, 0.7fr) minmax(0, 1fr) 220px;
      gap: 12px;
      align-items: stretch;
      margin-bottom: 12px;
    }
    .next-title { display: grid; gap: 7px; }
    .big-time { color: var(--blue); font-size: 26px; font-weight: 900; }
    .draw-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .summary-item { white-space: nowrap; }
    .jackpot-callout {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #f6c56d;
      border-radius: 6px;
      background: #fff4dd;
      padding: 4px 8px;
      white-space: nowrap;
    }
    .jackpot-label { color: #8a4b0f; font-size: 11px; font-weight: 800; }
    .jackpot-highlight {
      color: #9a3412;
      font-size: 24px;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      letter-spacing: .01em;
      line-height: 1;
    }
    .indicator-strip {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 7px;
    }
    .indicator {
      border: 1px solid #e5e7eb;
      background: var(--soft);
      border-radius: 6px;
      padding: 8px;
      min-width: 0;
    }
    .indicator span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 3px;
      white-space: nowrap;
    }
    .indicator strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
    }
    .pick-box {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
      align-content: center;
    }
    .pick-slot {
      aspect-ratio: 1 / 1;
      border: 2px dashed #c9c2b3;
      border-radius: 50%;
      background: #fffaf0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #9a8c76;
      font-weight: 800;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 10px;
    }
    .metric {
      border: 1px solid #e5e7eb;
      background: var(--soft);
      border-radius: 6px;
      padding: 9px;
    }
    .metric span { color: var(--muted); font-size: 11px; }
    .metric strong { display: block; margin-top: 2px; font-size: 18px; }
    .toolbar {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: white;
      padding: 7px 10px;
      color: #374151;
      font-size: 13px;
    }
    .tab.active { border-color: #17202a; background: #17202a; color: white; }
    .legend { color: var(--muted); font-size: 12px; }
    .balls {
      display: grid;
      grid-template-columns: repeat(13, minmax(42px, 1fr));
      gap: 8px;
    }
    .ball {
      aspect-ratio: 1 / 1;
      border: 1px solid #bfdbfe;
      border-radius: 50%;
      background: #e8eefc;
      color: #1e3a8a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      cursor: pointer;
      transition: transform .12s ease, background .12s ease, color .12s ease, border-color .12s ease;
      user-select: none;
    }
    .ball:hover { transform: translateY(-1px); }
    .ball.hot { border-color: var(--blue); background: var(--blue); color: white; }
    .ball.good { background: #dcf6e9; border-color: #a5dfc1; color: #145f3f; }
    .ball small { margin-top: 1px; color: currentColor; opacity: .82; font-size: 10px; font-weight: 800; }
    .ball.number-selected,
    .tiny-ball.number-selected {
      border-color: var(--selected);
      background: var(--selected);
      color: white;
      box-shadow: 0 0 0 3px rgba(225, 29, 72, .18);
    }
    .history { margin-top: 12px; }
    .history-head {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: start;
      margin-bottom: 10px;
    }
    .filter-grid {
      display: grid;
      grid-template-columns: 120px 120px 120px 130px 120px 130px 130px 130px minmax(160px, 1fr);
      gap: 8px;
      margin-bottom: 10px;
    }
    .filter {
      min-height: 38px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      background: white;
      padding: 5px 7px;
      color: #344054;
      font-size: 12px;
    }
    .filter label {
      display: block;
      color: var(--muted);
      font-size: 10px;
      margin-bottom: 2px;
      font-weight: 700;
    }
    .filter select,
    .filter input {
      width: 100%;
      border: 0;
      outline: 0;
      background: transparent;
      color: #344054;
      font-size: 12px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid #ece7dd;
      border-radius: 8px;
      max-height: 640px;
    }
    table {
      width: 100%;
      min-width: 980px;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid #ece7dd;
      padding: 9px 8px;
      text-align: left;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      background: #fbfaf6;
      z-index: 1;
      color: #475467;
      font-size: 12px;
    }
    tbody tr:hover { background: #fff9ed; }
    tbody tr.upcoming { background: #eef6ff; }
    .numset { display: flex; gap: 5px; align-items: center; }
    .tiny-ball {
      width: 25px;
      height: 25px;
      border: 1px solid #bfdbfe;
      border-radius: 50%;
      background: #e8eefc;
      color: #1d4ed8;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 900;
      cursor: pointer;
      user-select: none;
    }
    .blank-ball {
      width: 25px;
      height: 25px;
      border: 2px dashed #aac5e8;
      border-radius: 50%;
      background: white;
      display: inline-flex;
    }
    .pager {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      margin-top: 10px;
    }
    .note { color: var(--muted); font-size: 12px; margin: 9px 0 0; }
    @media (max-width: 1180px) {
      .next-draw { grid-template-columns: 1fr; }
      .filter-grid { grid-template-columns: repeat(4, 1fr); }
      .balls { grid-template-columns: repeat(10, minmax(42px, 1fr)); }
    }
    @media (max-width: 720px) {
      main { padding: 12px; }
      .top { grid-template-columns: 1fr; }
      .rollback { justify-content: flex-start; }
      .indicator-strip,
      .metrics,
      .filter-grid { grid-template-columns: repeat(2, 1fr); }
      .balls { grid-template-columns: repeat(5, minmax(42px, 1fr)); }
      .history-head { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>Fantasy 5 深度推演研究台</h1>
        <p class="subtitle">每日开奖 · 1-39 号码 · 18:25 洛杉矶时间锚点 · 118 个时空指标 · 历史相似样本概率排序</p>
        <div class="pills">
          <span class="pill blue">gpt.lucktime.net/5 专项页</span>
          <span class="pill green">点击号码联动高亮，再点取消</span>
          <span class="pill ${dataStatus.isStale ? "warn" : "green"}">${dataStatus.statusText}</span>
          <span class="pill">数据截止日期 ${dataStatus.latestDate ?? "无"}</span>
          <span class="pill">时支固定酉，五行固定金</span>
          <span class="pill">筛选使用时干五行</span>
        </div>
      </div>
      <div class="rollback" aria-label="开奖回滚">
        <button class="btn active">最新</button>
        <button class="btn">上1期</button>
        <button class="btn">上2期</button>
        <button class="btn">上3期</button>
        <button class="btn">上5期</button>
        <button class="btn">上10期</button>
      </div>
    </section>

    <section class="card next-draw">
      <div class="next-title">
        <h2>即将开奖</h2>
        <div class="big-time">${current.date} ${current.time}</div>
        <div class="draw-summary">
          <span class="summary-item">期号 ${current.issue}</span>
          <span class="jackpot-callout"><span class="jackpot-label">当前奖池</span><span class="jackpot-highlight">${current.jackpot}</span></span>
          <span class="summary-item">洛杉矶今天 ${dataStatus.todayLa}</span>
          <span class="summary-item">数据滞后 ${dataStatus.daysBehind ?? "未知"} 天</span>
        </div>
      </div>
      <div class="indicator-strip">
        <div class="indicator"><span>周几</span><strong>${current.weekday}</strong></div>
        <div class="indicator"><span>日干</span><strong>${current.dayStem}</strong></div>
        <div class="indicator"><span>日支</span><strong>${current.dayBranch}</strong></div>
        <div class="indicator"><span>日五行</span><strong>${current.dayElement}</strong></div>
        <div class="indicator"><span>时干五行</span><strong>${current.hourStemElement}</strong></div>
        <div class="indicator"><span>时支五行</span><strong>${current.hourBranchElement}</strong></div>
      </div>
      <div>
        <h3>选号空位</h3>
        <div class="pick-box">
          <span class="pick-slot">?</span>
          <span class="pick-slot">?</span>
          <span class="pick-slot">?</span>
          <span class="pick-slot">?</span>
          <span class="pick-slot">?</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="metrics">
        <div class="metric"><span>模型输入</span><strong>82</strong></div>
        <div class="metric"><span>原始时空指标</span><strong>118</strong></div>
        <div class="metric"><span>历史样本</span><strong>${dataStatus.totalRows}</strong></div>
        <div class="metric"><span>单号基准</span><strong>12.82%</strong></div>
      </div>
      <div class="toolbar">
        <div class="tabs">
          <span class="tab active">概率排序</span>
          <span class="tab">回测</span>
          <span class="tab">冷热</span>
          <span class="tab">指标库</span>
        </div>
        <div class="legend">点击一个号码，历史开奖和概率区同号一起变色</div>
      </div>
      <div class="balls" id="recommendations"></div>
      <p class="note">概率是最近历史样本收缩到单号基准后的估计出现率，只作研究观察，不是中奖保证。</p>
    </section>

    <section class="card history">
      <div class="history-head">
        <div>
          <h2>历史开奖</h2>
          <p class="subtitle">筛选框在历史区顶端。构建时读取并校验完整 CSV ${dataStatus.totalRows} 期，当前页面显示最近 ${history.length} 期真实日期和号码。</p>
        </div>
        <div class="pills">
          <span class="pill blue">当前显示 <span id="visible-count">0</span> 期</span>
          <span class="pill ${dataStatus.isStale ? "warn" : "green"}">${dataStatus.statusText}</span>
          <span class="pill">数据截止日期 ${dataStatus.latestDate ?? "无"}</span>
        </div>
      </div>

      <div class="filter-grid">
        <div class="filter"><label for="tail-filter">开奖日尾数</label><select id="tail-filter"></select></div>
        <div class="filter"><label for="weekday-filter">周几</label><select id="weekday-filter"></select></div>
        <div class="filter"><label for="stem-filter">日干</label><select id="stem-filter"></select></div>
        <div class="filter"><label for="branch-filter">日支</label><select id="branch-filter"></select></div>
        <div class="filter"><label for="element-filter">日五行</label><select id="element-filter"></select></div>
        <div class="filter"><label for="hour-element-filter">时干五行</label><select id="hour-element-filter"></select></div>
        <div class="filter"><label for="from-filter">开始日期</label><input id="from-filter" type="date"></div>
        <div class="filter"><label for="to-filter">结束日期</label><input id="to-filter" type="date"></div>
        <div class="filter"><label for="number-filter">号码搜索</label><input id="number-filter" inputmode="numeric" placeholder="输入 1-39"></div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>开奖日期/时间</th>
              <th>期号</th>
              <th>周几</th>
              <th>日干</th>
              <th>日支</th>
              <th>日五行</th>
              <th>时干五行</th>
              <th>时支五行</th>
              <th>开奖号码</th>
            </tr>
          </thead>
          <tbody id="history-body"></tbody>
        </table>
      </div>
      <div class="pager">
        <span>默认加载最近 ${history.length} 期；完整 CSV 当前校验 ${dataStatus.totalRows} 期，截止 ${dataStatus.latestDate ?? "无"}。</span>
        <span>上1期 / 上2期回滚按钮会在动态数据版联动。</span>
      </div>
    </section>
  </main>

  <script>
    window.F5_HISTORY = ${JSON.stringify(history)};
    window.F5_CURRENT = ${JSON.stringify(current)};
    window.F5_RECOMMENDATIONS = ${JSON.stringify(recommendations)};
    window.F5_DATA_STATUS = ${JSON.stringify(dataStatus)};
  </script>
  <script>
    const historyRows = window.F5_HISTORY;
    const currentDraw = window.F5_CURRENT;
    const recommendations = window.F5_RECOMMENDATIONS;
    const filters = {
      tail: document.getElementById("tail-filter"),
      weekday: document.getElementById("weekday-filter"),
      stem: document.getElementById("stem-filter"),
      branch: document.getElementById("branch-filter"),
      element: document.getElementById("element-filter"),
      hourElement: document.getElementById("hour-element-filter"),
      from: document.getElementById("from-filter"),
      to: document.getElementById("to-filter"),
      number: document.getElementById("number-filter"),
    };
    const historyBody = document.getElementById("history-body");
    const visibleCount = document.getElementById("visible-count");
    const recommendationsEl = document.getElementById("recommendations");
    let selectedNumber = null;

    function fillSelect(select, values, allLabel = "全部") {
      select.innerHTML = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = allLabel;
      select.appendChild(all);
      values.forEach((value) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = String(value);
        select.appendChild(option);
      });
    }

    function numberButton(number, className = "tiny-ball") {
      const span = document.createElement("span");
      span.className = className;
      span.dataset.number = String(number);
      span.textContent = number;
      span.addEventListener("click", () => setSelectedNumber(String(number)));
      return span;
    }

    function setSelectedNumber(number) {
      selectedNumber = selectedNumber === number ? null : number;
      document.querySelectorAll("[data-number]").forEach((node) => {
        node.classList.toggle("number-selected", selectedNumber !== null && node.dataset.number === selectedNumber);
      });
    }

    function renderRecommendations() {
      recommendationsEl.innerHTML = "";
      recommendations.forEach((item, index) => {
        const cell = numberButton(item.number, "ball");
        if (index < 5) cell.classList.add("hot");
        else if (index < 8) cell.classList.add("good");
        const pct = document.createElement("small");
        pct.textContent = item.probability.toFixed(1) + "%";
        cell.appendChild(pct);
        recommendationsEl.appendChild(cell);
      });
    }

    function blankNumbers() {
      const wrap = document.createElement("span");
      wrap.className = "numset";
      for (let index = 0; index < 5; index += 1) {
        const blank = document.createElement("span");
        blank.className = "blank-ball";
        wrap.appendChild(blank);
      }
      return wrap;
    }

    function numberSet(numbers) {
      const wrap = document.createElement("span");
      wrap.className = "numset";
      numbers.forEach((number) => wrap.appendChild(numberButton(number)));
      return wrap;
    }

    function appendCell(row, text) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.appendChild(cell);
      return cell;
    }

    function renderRow(rowData, upcoming = false) {
      const row = document.createElement("tr");
      if (upcoming) row.className = "upcoming";
      appendCell(row, upcoming ? currentDraw.date + " " + currentDraw.time : rowData.date);
      appendCell(row, rowData.issue);
      appendCell(row, rowData.weekday);
      appendCell(row, rowData.dayStem);
      appendCell(row, rowData.dayBranch);
      appendCell(row, rowData.dayElement);
      appendCell(row, rowData.hourStemElement);
      appendCell(row, rowData.hourBranchElement);
      const numbers = document.createElement("td");
      numbers.appendChild(upcoming ? blankNumbers() : numberSet(rowData.numbers));
      row.appendChild(numbers);
      return row;
    }

    function rowMatches(row) {
      const numberValue = filters.number.value.trim();
      if (filters.tail.value && String(row.tail) !== filters.tail.value) return false;
      if (filters.weekday.value && row.weekday !== filters.weekday.value) return false;
      if (filters.stem.value && row.dayStem !== filters.stem.value) return false;
      if (filters.branch.value && row.dayBranch !== filters.branch.value) return false;
      if (filters.element.value && row.dayElement !== filters.element.value) return false;
      if (filters.hourElement.value && row.hourStemElement !== filters.hourElement.value) return false;
      if (filters.from.value && row.date < filters.from.value) return false;
      if (filters.to.value && row.date > filters.to.value) return false;
      if (numberValue && !row.numbers.includes(Number(numberValue))) return false;
      return true;
    }

    function renderHistory() {
      const rows = historyRows.filter(rowMatches);
      historyBody.innerHTML = "";
      historyBody.appendChild(renderRow(currentDraw, true));
      rows.forEach((row) => historyBody.appendChild(renderRow(row)));
      visibleCount.textContent = String(rows.length);
      if (selectedNumber !== null) {
        const keep = selectedNumber;
        selectedNumber = null;
        setSelectedNumber(keep);
      }
    }

    fillSelect(filters.tail, Array.from({ length: 10 }, (_, index) => index));
    fillSelect(filters.weekday, ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
    fillSelect(filters.stem, ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]);
    fillSelect(filters.branch, ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]);
    fillSelect(filters.element, ["木", "火", "土", "金", "水"]);
    fillSelect(filters.hourElement, ["木", "火", "土", "金", "水"]);
    Object.values(filters).forEach((control) => control.addEventListener("input", renderHistory));
    Object.values(filters).forEach((control) => control.addEventListener("change", renderHistory));
    renderRecommendations();
    renderHistory();
  </script>
</body>
</html>`;

const worker = `const html = ${JSON.stringify(html)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/5") {
      return Response.redirect(new URL("/5", url), 302);
    }

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60"
      }
    });
  }
};
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, worker, "utf8");
writeFileSync(previewPath, html, "utf8");
console.log(`Built ${outputPath}`);
console.log(`Built ${previewPath}`);
