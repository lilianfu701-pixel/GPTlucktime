import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_CSV_PATH } from "../lib/history-data.mjs";
import { defaultSourceUrls, syncFantasy5History } from "../lib/fantasy5-sync.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const options = {
    csvPath: HISTORY_CSV_PATH,
    dryRun: false,
    sourceUrls: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--csv") {
      options.csvPath = argv[index + 1];
      index += 1;
    } else if (arg === "--source") {
      options.sourceUrls.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function helpText() {
  return [
    "Usage: node scripts/sync-fantasy5-history.mjs [--dry-run] [--csv PATH] [--source URL]",
    "",
    "Examples:",
    "  node scripts/sync-fantasy5-history.mjs --dry-run",
    "  node scripts/sync-fantasy5-history.mjs --source https://www.lotterycorner.com/ca/fantasy-5/2026",
  ].join("\n");
}

async function fetchText(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "lucktime-fantasy5-research/0.1",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${sourceUrl}`);
  }

  return response.text();
}

async function writeCsvAtomically(csvPath, text) {
  const absolutePath = resolve(csvPath);
  const tempPath = resolve(dirname(absolutePath), `.fantasy5-sync-${process.pid}.tmp`);
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, absolutePath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  const csvPath = resolve(options.csvPath);
  const sourceUrls = options.sourceUrls.length > 0 ? options.sourceUrls : defaultSourceUrls();
  const csvText = await readFile(csvPath, "utf8");
  const result = await syncFantasy5History({
    csvText,
    sourceUrls,
    dryRun: options.dryRun,
    fetchText,
    writeCsvText: (nextCsvText) => writeCsvAtomically(csvPath, nextCsvText),
  });

  console.log(`Checked sources: ${result.checked}`);
  for (const source of result.checkedSources) {
    console.log(`- ${source.sourceUrl} (${source.parsed} rows)`);
  }
  console.log(`Parsed remote rows: ${result.parsed}`);
  console.log(`New rows: ${result.added}`);
  console.log(`Updated rows: ${result.updated}`);
  console.log(`Latest date after merge: ${result.latestDate ?? "none"}`);
  console.log(options.dryRun ? "Dry run: CSV not written." : "CSV synchronized.");
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
