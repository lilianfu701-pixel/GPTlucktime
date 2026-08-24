import { spawnSync } from "node:child_process";

import { inspectAcceptancePreflight } from "./acceptance-preflight-lib";

const mode = process.argv[2];
if (mode !== "local" && mode !== "external") {
  console.error("Usage: tsx scripts/acceptance-preflight.ts <local|external>");
  process.exit(2);
}

const executableLookup = (name: string) => {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] ?? null : null;
};
const failures = inspectAcceptancePreflight(mode, process.env, executableLookup);
if (failures.length > 0) {
  console.error(`${mode.toUpperCase()} acceptance preflight failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`${mode.toUpperCase()} acceptance preflight passed.`);

