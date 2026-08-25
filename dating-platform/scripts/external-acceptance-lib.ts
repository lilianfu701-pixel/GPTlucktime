import { resolve } from "node:path";

export type AcceptanceCommand = { label: string; executable: string; args: string[] };

export function buildExternalAcceptanceCommands(): AcceptanceCommand[] {
  const tsx = ["--import", "tsx"];
  return [
    { label: "external preflight", executable: process.execPath, args: [...tsx, resolve("scripts/acceptance-preflight.ts"), "external"] },
    { label: "PostgreSQL backup", executable: process.execPath, args: [...tsx, resolve("scripts/verify-backup-restore.ts"), "backup"] },
    { label: "PostgreSQL restore verification", executable: process.execPath, args: [...tsx, resolve("scripts/verify-backup-restore.ts"), "restore"] },
    { label: "Stripe test-mode verification", executable: process.execPath, args: [...tsx, resolve("scripts/verify-stripe-test-mode.ts")] },
  ];
}
