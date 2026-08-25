import { createServer } from "node:http";

import { startRealtimeProcess } from "../realtime/server";
import { authorizeRealtimeControlRequest, inspectRealtimeControlConfig,
  parseRealtimeControlAction } from "./e2e-realtime-control-lib";

const failures = inspectRealtimeControlConfig(process.env);
if (failures.length > 0) throw new Error(`E2E_REALTIME_CONTROL_REJECTED:${failures.join(",")}`);

let runtime: Awaited<ReturnType<typeof startRealtimeProcess>> | null = null;
let lifecycle = Promise.resolve();
const start = async () => { runtime ??= await startRealtimeProcess(process.env); };
const stop = async () => {
  const current = runtime;
  runtime = null;
  await current?.stop();
};
await start();

const control = createServer((request, response) => {
  const action = parseRealtimeControlAction(request.method, request.url);
  const candidate = typeof request.headers["x-e2e-token"] === "string"
    ? request.headers["x-e2e-token"] : undefined;
  if (!action || !authorizeRealtimeControlRequest(process.env, request.socket.remoteAddress, candidate)) {
    response.writeHead(404).end();
    return;
  }
  lifecycle = lifecycle.then(async () => {
    if (action === "stop" || action === "restart") await stop();
    if (action === "start" || action === "restart") await start();
  });
  void lifecycle.then(() => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, action }));
  }, () => response.writeHead(500).end());
});

const controlPort = Number(process.env.E2E_REALTIME_CONTROL_PORT ?? 3101);
await new Promise<void>((resolveListen, rejectListen) => {
  control.once("error", rejectListen);
  control.listen(controlPort, "127.0.0.1", () => {
    control.off("error", rejectListen);
    resolveListen();
  });
});
process.stdout.write(`E2E_REALTIME_CONTROL_READY:127.0.0.1:${controlPort}\n`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolveClose) => control.close(() => resolveClose()));
  await stop();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
