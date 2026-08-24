import { describe, expect, it, vi } from "vitest";

import { getDemoConversationContext, getDemoHome, getDemoProfile } from "@/modules/demo/demo-service";

describe("DateCN demo service", () => {
  it("returns eight stable bilingual profiles without network access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = getDemoHome("en");
    const second = getDemoHome("en");

    expect(first).toEqual(second);
    expect(first.profiles).toHaveLength(8);
    expect(first.profiles.map((profile) => profile.id)).toEqual([
      "demo-lina", "demo-marcus", "demo-aiko", "demo-daniel",
      "demo-amara", "demo-sofia", "demo-wei", "demo-noor",
    ]);
    expect(getDemoProfile("demo-lina", "zh-CN")?.city).toBe("上海");
    expect(getDemoHome("zh-CN").matches[0]?.matchedAt).toBe("今天");
    expect(getDemoProfile("missing", "en")).toBeNull();
    expect(getDemoConversationContext("demo-marcus", "en").profile.id).toBe("demo-marcus");
    expect(getDemoConversationContext("conversation-marcus", "en").profile.id).toBe("demo-marcus");
    expect(getDemoConversationContext("unknown-profile", "en").profile.id).toBe("demo-lina");
    expect(getDemoConversationContext("x".repeat(65), "en").profile.id).toBe("demo-lina");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
