// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readBoundedJson } from "@/shared/http/read-bounded-json";

describe("bounded JSON reader", () => {
  it("accepts a valid streamed body exactly at the configured byte boundary", async () => {
    const json = `${JSON.stringify({ ok: true })}${" ".repeat(8192 - JSON.stringify({ ok: true }).length)}`;
    const request = new Request("https://app.example.test", { method: "POST",
      headers: { "content-type": "application/json" }, body: json });
    await expect(readBoundedJson(request, 8192)).resolves.toEqual({ ok: true });
  });
});
