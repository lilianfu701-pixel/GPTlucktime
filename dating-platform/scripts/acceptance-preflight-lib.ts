import { inspectBackupPreflight } from "./backup-restore-lib";

type ExecutableLookup = (name: string) => string | null;

export function inspectAcceptancePreflight(
  mode: "local" | "external",
  env: Partial<NodeJS.ProcessEnv>,
  lookup: ExecutableLookup,
) {
  if (mode === "local") {
    const failures: string[] = [];
    if (env.NODE_ENV !== "test") failures.push("NODE_ENV must be test for local acceptance");
    if (env.E2E_MODE !== "1") failures.push("E2E_MODE must be 1 for local acceptance");
    if (!env.E2E_CONTROL_TOKEN || env.E2E_CONTROL_TOKEN.length < 32) {
      failures.push("E2E_CONTROL_TOKEN must contain at least 32 characters");
    }
    return failures;
  }

  const failures = inspectBackupPreflight(env, lookup);
  if (!env.STRIPE_SECRET_KEY) failures.push("STRIPE_SECRET_KEY is required for the external provider gate");
  if (!env.STRIPE_WEBHOOK_SECRET) failures.push("STRIPE_WEBHOOK_SECRET is required for the external provider gate");
  if (!env.STRIPE_TEST_PRICE_ID) failures.push("STRIPE_TEST_PRICE_ID is required for the external provider gate");
  let webhookUrlValid = false;
  try { webhookUrlValid = new URL(env.STRIPE_TEST_WEBHOOK_URL ?? "").protocol === "https:"; } catch { /* fail closed */ }
  if (!webhookUrlValid) failures.push("STRIPE_TEST_WEBHOOK_URL must be an HTTPS acceptance endpoint");
  return failures;
}
