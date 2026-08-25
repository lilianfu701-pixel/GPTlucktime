import { spawnSync } from "node:child_process";
import { buildLocalAcceptanceCommands, buildLocalE2eEnvironment,
  selectLocalAcceptanceEnvironment } from "./local-acceptance-lib";

const environment = buildLocalE2eEnvironment(process.env);

for (const command of buildLocalAcceptanceCommands(process.argv.slice(2))) {
  console.log(`LOCAL_ACCEPTANCE_GATE:${command.label}`);
  const env = selectLocalAcceptanceEnvironment(command.label, environment, process.env);
  const result = spawnSync(command.executable, command.args, { env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
