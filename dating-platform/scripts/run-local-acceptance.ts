import { spawnSync } from "node:child_process";
import { buildLocalAcceptanceCommands, selectLocalAcceptanceEnvironment } from "./local-acceptance-lib";

const port = process.env.E2E_PORT ?? "3200";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  E2E_MODE: "1",
  E2E_CONTROL_TOKEN: process.env.E2E_CONTROL_TOKEN ?? "local-acceptance-token-at-least-32-characters",
  E2E_DATABASE_PATH: process.env.E2E_DATABASE_PATH ?? ".artifacts/e2e/member-acceptance-db-socket",
  E2E_DATABASE_PORT: process.env.E2E_DATABASE_PORT ?? "55432",
  E2E_PORT: port,
  APP_URL: process.env.APP_URL ?? `http://127.0.0.1:${port}`,
};

for (const command of buildLocalAcceptanceCommands(process.argv.slice(2))) {
  console.log(`LOCAL_ACCEPTANCE_GATE:${command.label}`);
  const env = selectLocalAcceptanceEnvironment(command.label, environment, process.env);
  const result = spawnSync(command.executable, command.args, { env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
