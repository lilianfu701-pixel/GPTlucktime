import { describe, expect, it } from "vitest";
import { isKinCandidate } from "@/modules/genealogy/self-discovery";

describe("isKinCandidate", () => {
  const node = { displayName: "孔垂长", generationName: "垂" };

  it("matches on an exact name", () => {
    expect(isKinCandidate({ fullName: "孔垂长" }, node)).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isKinCandidate({ fullName: "  孔垂长 " }, node)).toBe(true);
  });

  it("rejects a different name", () => {
    expect(isKinCandidate({ fullName: "孔德成" }, node)).toBe(false);
  });

  it("requires a name", () => {
    expect(isKinCandidate({ fullName: "" }, node)).toBe(false);
    expect(isKinCandidate({ fullName: "孔垂长" }, { displayName: null, generationName: null })).toBe(
      false,
    );
  });

  it("confirms when the stated 字辈 agrees", () => {
    expect(isKinCandidate({ fullName: "孔垂长", generationName: "垂" }, node)).toBe(true);
  });

  it("rejects a same-named person of a contradicting 字辈", () => {
    expect(isKinCandidate({ fullName: "孔垂长", generationName: "德" }, node)).toBe(false);
  });

  it("still matches when the viewer states no 字辈", () => {
    expect(isKinCandidate({ fullName: "孔垂长" }, node)).toBe(true);
    // A node with no recorded 字辈 is not excluded by a viewer who states one.
    expect(
      isKinCandidate({ fullName: "孔垂长", generationName: "垂" }, {
        displayName: "孔垂长",
        generationName: null,
      }),
    ).toBe(true);
  });
});
