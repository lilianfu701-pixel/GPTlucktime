import {
  mergeHistoryRows,
  parseHistoryCsv,
  serializeHistoryCsv,
  validateHistoryRow,
} from "./history-data.mjs";

const monthNumbers = new Map([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

const datePattern =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s*(\d{4})\b/gi;

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToSearchText(html) {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function weekdayForDate(dateText) {
  return new Date(`${dateText}T12:00:00-08:00`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/Los_Angeles",
  });
}

export function parseJackpotAmount(jackpotText) {
  const text = String(jackpotText ?? "").trim();
  const numeric = Number((text.match(/[\d,.]+/)?.[0] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (/billion/i.test(text)) {
    return Math.round(numeric * 1_000_000_000);
  }
  if (/million/i.test(text)) {
    return Math.round(numeric * 1_000_000);
  }
  return Math.round(numeric);
}

function parseDateMatch(match) {
  const month = monthNumbers.get(match[1].replace(/\.$/, "").toLowerCase());
  if (!month) {
    return null;
  }

  return formatDate(Number(match[3]), month, Number(match[2]));
}

function extractNumbers(chunk) {
  const jackpotIndex = chunk.search(/\$\s*[\d,.]+(?:\s*(?:Million|Billion))?/i);
  const numberText = jackpotIndex >= 0 ? chunk.slice(0, jackpotIndex) : chunk;
  const numbers = (numberText.match(/\b(?:[1-9]|[1-3]\d)\b/g) ?? []).map(Number);
  return numbers.slice(0, 5);
}

export function parseLotteryCornerFantasy5Rows(html, sourceUrl) {
  const text = htmlToSearchText(html);
  const matches = Array.from(text.matchAll(datePattern));
  const rows = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const drawDate = parseDateMatch(match);
    if (!drawDate) {
      continue;
    }

    const chunkStart = match.index + match[0].length;
    const chunkEnd = matches[index + 1]?.index ?? text.length;
    const chunk = text.slice(chunkStart, chunkEnd);
    const numbers = extractNumbers(chunk);
    const jackpotText = chunk.match(/\$\s*[\d,.]+(?:\s*(?:Million|Billion))?/i)?.[0] ?? "";

    if (numbers.length !== 5) {
      continue;
    }

    rows.push(
      validateHistoryRow({
        draw_date: drawDate,
        weekday: weekdayForDate(drawDate),
        number_1: numbers[0],
        number_2: numbers[1],
        number_3: numbers[2],
        number_4: numbers[3],
        number_5: numbers[4],
        jackpot_text: jackpotText.replace(/\s+/g, " "),
        jackpot_amount: parseJackpotAmount(jackpotText),
        rule_version: "FANTASY5_5_OF_39",
        source_url: sourceUrl,
      }),
    );
  }

  return rows;
}

function rowsDiffer(left, right) {
  return (
    left.weekday !== right.weekday ||
    left.jackpot_text !== right.jackpot_text ||
    left.jackpot_amount !== right.jackpot_amount ||
    left.source_url !== right.source_url ||
    left.numbers.join(",") !== right.numbers.join(",")
  );
}

export function defaultSourceUrls(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
  const year = Number(formatter.format(now));
  return [year, year - 1].map((item) => `https://www.lotterycorner.com/ca/fantasy-5/${item}`);
}

export async function syncFantasy5History({
  csvText,
  fetchText,
  writeCsvText,
  sourceUrls = defaultSourceUrls(),
  dryRun = false,
}) {
  const existingRows = parseHistoryCsv(csvText);
  const existingByDate = new Map(existingRows.map((row) => [row.draw_date, row]));
  const fetchedRows = [];
  const checkedSources = [];

  for (const sourceUrl of sourceUrls) {
    const html = await fetchText(sourceUrl);
    const parsedRows = parseLotteryCornerFantasy5Rows(html, sourceUrl);
    checkedSources.push({ sourceUrl, parsed: parsedRows.length });
    fetchedRows.push(...parsedRows);
  }

  const fetchedByDate = new Map(fetchedRows.map((row) => [row.draw_date, row]));
  const incomingRows = Array.from(fetchedByDate.values());
  const added = incomingRows.filter((row) => !existingByDate.has(row.draw_date)).length;
  const updated = incomingRows.filter((row) => {
    const existing = existingByDate.get(row.draw_date);
    return existing && rowsDiffer(existing, row);
  }).length;
  const mergedRows = mergeHistoryRows(existingRows, incomingRows);
  const latestDate = mergedRows.at(-1)?.draw_date ?? null;
  const nextCsvText = serializeHistoryCsv(mergedRows);

  if (!dryRun && (added > 0 || updated > 0)) {
    await writeCsvText(nextCsvText);
  }

  return {
    checked: sourceUrls.length,
    checkedSources,
    parsed: incomingRows.length,
    added,
    updated,
    latestDate,
    csvText: nextCsvText,
  };
}
