import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MIGRATION_GATE_ERROR = "FREE_TEST_MIGRATION_GATE_REJECTED";
const CONFIRMATION = "--confirm=datecn-free-test";
const SECURE_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);
const ALLOWED_QUERY_PARAMETERS = new Set(["sslmode", "channel_binding"]);
const AMBIENT_POSTGRES_VARIABLE = /^PG[A-Z0-9_]*$/u;

const rejected = () => new Error(MIGRATION_GATE_ERROR);

export function parseFreeTestDatabaseTarget(env) {
  try {
    for (const [name, value] of Object.entries(env)) {
      if (AMBIENT_POSTGRES_VARIABLE.test(name)
        && typeof value === "string" && value.length > 0) throw rejected();
    }
    const raw = env.DATABASE_URL;
    if (typeof raw !== "string" || raw.length === 0) throw rejected();
    const url = new URL(raw);
    if (url.protocol !== "postgresql:" || !url.username || !url.password || url.hash) throw rejected();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (/[\u0000-\u001F\u007F]/u.test(username + password)) throw rejected();

    const host = url.hostname.toLowerCase();
    const address = host.replace(/^\[|\]$/gu, "");
    if (host.endsWith(".") || isIP(address) !== 0
      || host === "neon.tech" || !host.endsWith(".neon.tech")) throw rejected();

    if ([...url.searchParams.keys()].some((name) => !ALLOWED_QUERY_PARAMETERS.has(name))) {
      throw rejected();
    }
    const sslModes = url.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || !SECURE_SSL_MODES.has(sslModes[0])) throw rejected();
    const channelBindings = url.searchParams.getAll("channel_binding");
    if (channelBindings.length > 1
      || (channelBindings.length === 1 && channelBindings[0] !== "require")) throw rejected();

    const database = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    if (!database || database.includes("/") || /[\u0000-\u001F\u007F]/u.test(database)) throw rejected();
    return { host, database };
  } catch {
    throw rejected();
  }
}

export function parseMigrationArguments(argv) {
  if (argv.length !== 5) throw rejected();
  const { expectedHost, expectedDatabase } = parseExpectedDatabaseArguments(argv.slice(0, 4));
  const modeArgument = argv[4];
  if (modeArgument !== "--check" && modeArgument !== CONFIRMATION) throw rejected();
  return { expectedHost, expectedDatabase, mode: modeArgument === "--check" ? "check" : "migrate" };
}

export function parseExpectedDatabaseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--expected-host"
    || argv[2] !== "--expected-database") throw rejected();
  const expectedHost = argv[1];
  const expectedDatabase = argv[3];
  if (!expectedHost || !expectedDatabase
    || /[\u0000-\u001F\u007F]/u.test(expectedHost + expectedDatabase)) throw rejected();
  return { expectedHost, expectedDatabase };
}

export function requireExactDatabaseTarget(target, expected) {
  if (expected.expectedHost !== target.host || expected.expectedDatabase !== target.database) throw rejected();
  return target;
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
  requireExactDatabaseTarget(target, input);

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
