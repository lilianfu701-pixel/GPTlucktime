import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MIGRATION_GATE_ERROR = "FREE_TEST_MIGRATION_GATE_REJECTED";
const CONFIRMATION = "--confirm=datecn-free-test";
const SECURE_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

const rejected = () => new Error(MIGRATION_GATE_ERROR);

export function parseFreeTestDatabaseTarget(env) {
  try {
    const raw = env.DATABASE_URL;
    if (typeof raw !== "string" || raw.length === 0) throw rejected();
    const url = new URL(raw);
    if (url.protocol !== "postgresql:" || !url.username || !url.password || url.hash) throw rejected();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);

    const host = url.hostname.toLowerCase();
    const address = host.replace(/^\[|\]$/gu, "");
    if (host.endsWith(".") || isIP(address) !== 0
      || host === "neon.tech" || !host.endsWith(".neon.tech")) throw rejected();

    const sslModes = url.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || !SECURE_SSL_MODES.has(sslModes[0])) throw rejected();

    const database = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    if (!database || database.includes("/") || /[\u0000-\u001F\u007F]/u.test(database)) throw rejected();
    return { host, database };
  } catch {
    throw rejected();
  }
}

export function parseMigrationArguments(argv) {
  if (argv.length !== 5 || argv[0] !== "--expected-host"
    || argv[2] !== "--expected-database") throw rejected();
  const expectedHost = argv[1];
  const expectedDatabase = argv[3];
  const modeArgument = argv[4];
  if (!expectedHost || !expectedDatabase
    || /[\u0000-\u001F\u007F]/u.test(expectedHost + expectedDatabase)) throw rejected();
  if (modeArgument !== "--check" && modeArgument !== CONFIRMATION) throw rejected();
  return { expectedHost, expectedDatabase, mode: modeArgument === "--check" ? "check" : "migrate" };
}

export function selectNpmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function runFreeTestMigration({
  argv,
  env,
  platform = process.platform,
  spawn = spawnSync,
  writeStdout = (message) => process.stdout.write(message),
}) {
  const target = parseFreeTestDatabaseTarget(env);
  const input = parseMigrationArguments(argv);
  if (input.expectedHost !== target.host || input.expectedDatabase !== target.database) throw rejected();

  writeStdout(`Database target: host=${target.host}; db=${target.database}\n`);
  if (input.mode === "check") return 0;

  let result;
  try {
    result = spawn(selectNpmCommand(platform), ["run", "db:migrate"], {
      env,
      shell: false,
      stdio: "inherit",
    });
  } catch {
    throw rejected();
  }
  if (result.error || !Number.isInteger(result.status)) throw rejected();
  return result.status;
}

export function executeMigrationCli({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  writeStdout = (message) => process.stdout.write(message),
  writeStderr = (message) => process.stderr.write(message),
} = {}) {
  try {
    return runFreeTestMigration({ argv, env, platform, spawn, writeStdout });
  } catch {
    writeStderr(`${MIGRATION_GATE_ERROR}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = executeMigrationCli();
