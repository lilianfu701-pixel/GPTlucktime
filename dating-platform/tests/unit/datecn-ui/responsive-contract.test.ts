import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("DateCN responsive navigation", () => {
  it("keeps bottom navigation visible until the desktop sidebar appears", () => {
    const mobile = read("src/components/datecn/mobile-nav.tsx");
    const shell = read("src/components/datecn/member-shell.tsx");
    expect(mobile).toContain("lg:hidden");
    expect(mobile).not.toContain("md:hidden");
    expect(shell).toContain("lg:block");
  });

  it("uses a square inner sprite crop and the optimized local derivative", () => {
    const photo = read("src/components/datecn/profile-photo.tsx");
    const css = read("src/app/globals.css");
    expect(photo).toContain("profile-sprite-8.webp");
    expect(photo).toContain("datecn-photo-sprite");
    expect(css).toContain("max(100cqw, 100cqh)");
  });

  it("uses an accessible gold token for text, focus, and recommended badges", () => {
    const css = read("src/app/globals.css");
    const membership = read("src/components/datecn/membership-demo.tsx");
    expect(css).toContain("--datecn-gold: #79551f");
    expect(css).toContain("--datecn-gold-soft: #d4a95d");
    expect(css).toContain("outline: 3px solid var(--datecn-gold)");
    expect(membership).toContain("bg-[var(--datecn-gold)]");
  });

  it("keeps the free test banner within a 390px viewport without covering content", () => {
    const banner = read("src/components/datecn/free-test-banner.tsx");
    expect(banner).toContain("w-full");
    expect(banner).toContain("max-w-full");
    expect(banner).toContain("break-words");
    expect(banner).not.toMatch(/\b(?:fixed|sticky)\b/u);
    expect(banner).not.toMatch(/\bmin-w-(?:\[|\d)/u);
    expect(banner).not.toMatch(/\bw-\[(?:39[1-9]|[4-9]\d\d|\d{4,})px\]/u);
  });
});
