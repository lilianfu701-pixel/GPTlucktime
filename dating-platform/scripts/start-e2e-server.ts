import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "../src/db/schema/index";
import { requireE2eRuntime } from "../src/modules/e2e/e2e-guard";

const { databasePath } = requireE2eRuntime(process.env);
const databasePort = Number(process.env.E2E_DATABASE_PORT ?? 55432);
if (!Number.isInteger(databasePort) || databasePort < 1024 || databasePort > 65_535) {
  throw new Error("E2E_RUNTIME_REJECTED");
}

const absolutePath = resolve(databasePath);
const allowedRoot = resolve(".artifacts/e2e");
if (!absolutePath.startsWith(`${allowedRoot}${sep}`)) throw new Error("E2E_DATABASE_PATH_REJECTED");
await mkdir(dirname(absolutePath), { recursive: true });
const pglite = new PGlite(absolutePath);
const migrationDatabase = drizzle(pglite, { schema });
await migrate(migrationDatabase, { migrationsFolder: resolve("drizzle") });

const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: databasePort, maxConnections: 20 });
await socket.start();
process.stdout.write(`E2E_DATABASE_READY:${databasePort}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await socket.stop().catch(() => undefined);
  await pglite.close().catch(() => undefined);
  process.exit(0);
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
