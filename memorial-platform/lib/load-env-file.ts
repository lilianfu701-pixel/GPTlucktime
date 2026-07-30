import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads a local env file for processes Next.js does not start.
 *
 * The web application reads `.env.local` itself; scripts run through tsx — the
 * seed and the worker — do not. Without this they fail configuration validation
 * on a developer machine even though the file is right there.
 *
 * A missing file is not an error: in a deployed environment the values come from
 * the platform's secret manager and no file exists. Existing variables always
 * win, so an explicit `DATABASE_URL=... npm run db:seed` is never overridden by
 * whatever happens to be in the file.
 */
export function loadEnvFileIfPresent(
  fileNames = [".env.local", ".env"],
): string | null {
  for (const fileName of fileNames) {
    const path = join(process.cwd(), fileName);
    if (!existsSync(path)) {
      continue;
    }

    const before = new Set(Object.keys(process.env));
    process.loadEnvFile(path);

    // `loadEnvFile` does not overwrite existing variables, but restore anything
    // that was already set in case that changes.
    for (const key of before) {
      const original = process.env[key];
      if (original !== undefined) {
        process.env[key] = original;
      }
    }

    return fileName;
  }

  return null;
}
