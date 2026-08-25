import { inspectBackupPreflight } from "./backup-restore-lib";
import { inspectStripeTestConfig } from "./stripe-test-verifier-lib";

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
  return [...failures, ...inspectStripeTestConfig(env)];
}
