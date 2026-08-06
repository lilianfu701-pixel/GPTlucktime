import { closeDb } from "@/db/client";
import { loadEnvFileIfPresent } from "@/lib/load-env-file";
import { seedPlans } from "./plans";
import { seedRelationshipTypes } from "./relationship-types";
import { seedReligions } from "./religions";

// Next.js loads .env.local for the application; a tsx script must do it itself.
loadEnvFileIfPresent();

/**
 * Seeds reference data. Idempotent: running it twice changes nothing.
 *
 * Only neutral classification entries are inserted. No ritual version is
 * seeded, which means the platform offers no way of remembering to any family
 * until a reviewed version is published. That is the intended state until the
 * advisers in doc 11 section 4 are appointed.
 */
async function main(): Promise<void> {
  const counts = await seedReligions();
  const planCounts = await seedPlans();
  const relCounts = await seedRelationshipTypes();

  process.stdout.write(
    [
      "seeded reference data:",
      `  religions:           ${counts.religions}`,
      `  cultural traditions: ${counts.culturalTraditions}`,
      `  ritual definitions:  ${counts.ritualDefinitions}`,
      `  ritual versions:     ${counts.ritualVersions}`,
      `  features:            ${planCounts.features}`,
      `  plans:               ${planCounts.plans}`,
      `  paid plans:          ${planCounts.paidPlans}`,
      `  relationship types:  ${relCounts.relationshipTypes}`,
      "",
      "No paid plan exists, and nothing in this application creates an order.",
      "",
      "No ritual version exists, so no ritual can be offered on any memorial.",
      "Publishing one requires a source, a scope, a named reviewer and a",
      "human-reviewed translation. See docs/memorial-platform/05 and 11.",
      "",
    ].join("\n"),
  );

  await closeDb();
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${String(error)}\n`);
  process.exitCode = 1;
});
