// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("0013 online quota and timezone safety", () => {
  const sql = readFileSync("drizzle/0013_online_quota_and_timezone_safety.sql", "utf8");

  it("bounds lock exposure and replaces the nullable constraint with a partial index", () => {
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).toContain("WHERE \"profile_photo_uploads\".\"quota_slot\" IS NOT NULL");
  });

  it("conservatively hides legacy active profiles that have no legal timezone", () => {
    expect(sql).toContain("WHERE \"status\" = 'active' AND \"time_zone\" IS NULL");
    expect(sql).toContain("\"status\" = 'draft', \"discoverable\" = false, \"publish_requested\" = false");
  });
});
