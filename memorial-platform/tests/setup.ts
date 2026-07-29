/**
 * Runs before every test file.
 *
 * Keeps the suite deterministic across machines: all timestamps in this system
 * are stored in UTC, so tests must not inherit a developer's local timezone.
 */
process.env.TZ = "UTC";

/**
 * Vitest sets `NODE_ENV=test` itself. Asserting it here means a test run can
 * never quietly pick up development or production configuration — which, once
 * integration tests are wired to a real database, would be the difference
 * between truncating a test schema and truncating a real one.
 */
if (process.env.NODE_ENV !== "test") {
  throw new Error(
    `Tests must run with NODE_ENV=test, received ${String(process.env.NODE_ENV)}.`,
  );
}
