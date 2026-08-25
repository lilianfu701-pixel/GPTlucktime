const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3200";
const token = process.env.E2E_CONTROL_TOKEN;

if (process.env.NODE_ENV !== "test" || process.env.E2E_MODE !== "1" || !token || token.length < 32) {
  throw new Error("E2E_RUNTIME_REJECTED");
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("E2E_RUNTIME_REJECTED");
}

const response = await fetch(new URL("/api/e2e/control", baseURL), {
  method: "POST",
  headers: { "content-type": "application/json", "x-e2e-token": token },
  body: JSON.stringify({ action: "reset" }),
});
if (!response.ok) throw new Error(`E2E_SEED_FAILED_${response.status}`);
process.stdout.write(`${JSON.stringify(await response.json())}\n`);

export {};
