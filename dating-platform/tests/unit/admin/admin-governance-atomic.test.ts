import { describe, expect, it } from "vitest";

import { DrizzleCaseService } from "@/modules/moderation/case-service";

describe("admin governance atomic Task10 projection", () => {
  it("exposes an explicit same-transaction action entry point", () => {
    expect(typeof DrizzleCaseService.prototype.recordActionInTransaction).toBe("function");
  });
});
