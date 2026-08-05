import { describe, expect, it } from "vitest";
import { readEnv } from "@/shared/env";

describe("readEnv", () => {
  it("rejects an incomplete server environment", () => {
    expect(() => readEnv({ NODE_ENV: "test" })).toThrow("DATABASE_URL");
  });
});
