import { spawnSync } from "node:child_process";

import { buildExternalAcceptanceCommands } from "./external-acceptance-lib";

for (const command of buildExternalAcceptanceCommands()) {
  console.log(`EXTERNAL_ACCEPTANCE_GATE:${command.label}`);
  const result = spawnSync(command.executable, command.args, { env: process.env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
