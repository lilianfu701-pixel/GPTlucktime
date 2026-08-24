import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("DateCN public presentation", () => {
  it("offers the original hero, demo, sign-in, trust, steps, and profile preview", () => {
    const source = read("src/app/[locale]/(marketing)/page.tsx");
    expect(source).toContain("/demo/datecn-hero.png");
    expect(source).toContain("/demo/discover");
    expect(source).toContain("/sign-in");
    expect(source).toContain("step1Title");
    expect(source).toContain("safetyTitle");
    expect(source).toContain("ProfileCard");
  });

  it("keeps authentication submission while adding demo and registration presentation", () => {
    const page = read("src/app/[locale]/(auth)/sign-in/page.tsx");
    const form = read("src/app/[locale]/(auth)/sign-in/sign-in-form.tsx");
    expect(page).toContain("/demo/discover");
    expect(form).toContain("authClient.signIn.email");
    expect(form).toContain("registerTab");
    expect(form).toContain("showPassword");
    expect(page).toContain("<h1 className=\"mt-6");
  });

  it("keeps profile verification accessible and message links contextual", () => {
    const profile = read("src/app/[locale]/demo/profile/[profileId]/page.tsx");
    const matches = read("src/app/[locale]/demo/matches/page.tsx");
    expect(profile).toContain("aria-label={datecn(\"verified\")}");
    expect(profile).toContain("?with=${profile.id}");
    expect(matches).toContain("?with=${profile.id}");
  });
});
