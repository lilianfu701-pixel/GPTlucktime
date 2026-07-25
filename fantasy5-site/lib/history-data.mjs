import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HISTORY_CSV_PATH = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "data/california_fantasy_5_complete_history.csv",
);

export const HISTORY_HEADERS = [
  "draw_date",
  "weekday",
  "number_1",
  "number_2",
  "number_3",
  "number_4",
  "number_5",
  "jackpot_text",
  "jackpot_amount",
  "rule_version",
  "source_url",
];

const ruleVersion = "FANTASY5_5_OF_39";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function parseCsv(text) {
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

  return rows.filter((items) => items.some((item) => item.trim() !== ""));
}

function parseInteger(value, label) {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (text === "") {
    return null;
  }

  const number = Number(text);
  if (!Number.isInteger(number)) {
    throw new Error(`${label} must be an integer`);
  }

  return number;
}

function normalizeWeekday(rawWeekday, dateText) {
  const weekday = String(rawWeekday ?? "").trim();
  if (weekday) {
    return weekday;
  }

  const date = new Date(`${dateText}T12:00:00-08:00`);
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });
}

export function validateHistoryRow(rawRow) {
  const drawDate = String(rawRow.draw_date ?? "").trim();
  if (!datePattern.test(drawDate)) {
    throw new Error(`draw_date must be YYYY-MM-DD: ${drawDate}`);
  }

  const version = String(rawRow.rule_version ?? ruleVersion).trim();
  if (version !== ruleVersion) {
    throw new Error(`unsupported rule_version: ${version}`);
  }

  const numbers = [1, 2, 3, 4, 5].map((index) => {
    const number = parseInteger(rawRow[`number_${index}`], `number_${index}`);
    if (number === null || number < 1 || number > 39) {
      throw new Error(`number_${index} must be in 1-39`);
    }
    return number;
  });

  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`duplicate Fantasy 5 numbers for ${drawDate}`);
  }

  return {
    draw_date: drawDate,
    weekday: normalizeWeekday(rawRow.weekday, drawDate),
    numbers,
    jackpot_text: String(rawRow.jackpot_text ?? "").trim(),
    jackpot_amount: parseInteger(rawRow.jackpot_amount, "jackpot_amount"),
    rule_version: ruleVersion,
    source_url: String(rawRow.source_url ?? "").trim(),
  };
}

export function parseHistoryCsv(text) {
  const [headerRow, ...valueRows] = parseCsv(text);
  if (!headerRow) {
    return [];
  }

  const headers = headerRow.map((header) => header.replace(/^\uFEFF/, "").trim());
  return valueRows
    .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ""])))
    .filter((row) => String(row.rule_version ?? ruleVersion).trim() === ruleVersion)
    .map(validateHistoryRow);
}

export function mergeHistoryRows(existingRows, candidateRows) {
  const rowsByDate = new Map();

  for (const row of existingRows) {
    rowsByDate.set(row.draw_date, row);
  }

  for (const row of candidateRows) {
    rowsByDate.set(row.draw_date, validateHistoryRow(toRawHistoryRow(row)));
  }

  return Array.from(rowsByDate.values()).sort((left, right) =>
    left.draw_date.localeCompare(right.draw_date),
  );
}

function quoteCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function toRawHistoryRow(row) {
  return {
    draw_date: row.draw_date,
    weekday: row.weekday,
    number_1: row.numbers?.[0] ?? row.number_1,
    number_2: row.numbers?.[1] ?? row.number_2,
    number_3: row.numbers?.[2] ?? row.number_3,
    number_4: row.numbers?.[3] ?? row.number_4,
    number_5: row.numbers?.[4] ?? row.number_5,
    jackpot_text: row.jackpot_text,
    jackpot_amount: row.jackpot_amount,
    rule_version: row.rule_version,
    source_url: row.source_url,
  };
}

export function serializeHistoryCsv(rows) {
  const lines = [HISTORY_HEADERS.join(",")];

  for (const row of rows) {
    const raw = toRawHistoryRow(validateHistoryRow(toRawHistoryRow(row)));
    lines.push(
      HISTORY_HEADERS.map((header) => quoteCsvCell(raw[header] ?? "")).join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function readHistoryCsvFile(path = HISTORY_CSV_PATH) {
  return parseHistoryCsv(await readFile(path, "utf8"));
}
