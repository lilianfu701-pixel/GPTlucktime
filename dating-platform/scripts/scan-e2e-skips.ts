import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const acceptanceFiles = readdirSync(resolve("tests/e2e"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.spec\.ts$/u.test(entry.name));
for (const entry of acceptanceFiles) {
  const path = resolve(entry.parentPath, entry.name);
  if (/\b(?:skip|fixme)\b/iu.test(readFileSync(path, "utf8"))) {
    console.error(`LOCAL_ACCEPTANCE_REJECTED_SKIPPED_TEST:${path}`);
    process.exit(1);
  }
}
console.log(`LOCAL_ACCEPTANCE_SKIP_SCAN_OK:${acceptanceFiles.length}`);
