import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  twoFactors,
  users,
  verificationAttempts,
  verificationWebhookEvents,
} from "@/db/schema";

describe("authentication schema", () => {
  it("includes stable phone and two-factor plugin fields", () => {
    expect(Object.keys(getTableColumns(users))).toEqual(expect.arrayContaining([
      "phoneNumber",
      "phoneNumberVerified",
      "twoFactorEnabled",
    ]));
    expect(Object.keys(getTableColumns(twoFactors))).toEqual(expect.arrayContaining([
      "id",
      "secret",
      "backupCodes",
      "userId",
      "verified",
      "failedVerificationCount",
      "lockedUntil",
    ]));
  });

  it("stores provider-scoped webhook event ids without identity documents", () => {
    expect(getTableConfig(verificationWebhookEvents).uniqueConstraints[0]?.columns.map(
      (column) => column.name,
    )).toEqual(["provider", "event_id"]);
    expect(Object.keys(getTableColumns(verificationWebhookEvents))).not.toContain("payload");
    expect(Object.keys(getTableColumns(verificationAttempts))).toContain("provider");
  });
});
