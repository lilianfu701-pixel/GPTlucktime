import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key)).sort();
}

describe("DateCN visible MVP contract", () => {
  it("provides every public demo route through the isolated service", () => {
    for (const route of ["discover", "matches", "messages", "membership", "me"]) {
      expect(read(`src/app/[locale]/demo/${route}/page.tsx`)).toContain("@/modules/demo/demo-service");
    }
    expect(read("src/app/[locale]/demo/profile/[profileId]/page.tsx")).toContain("@/modules/demo/demo-service");
  });

  it("keeps demo sources away from network, database, payment, and environment clients", () => {
    const source = ["demo-types.ts", "demo-data.ts", "demo-service.ts"].map((file) => read(`src/modules/demo/${file}`)).join("\n");
    expect(source).not.toMatch(/fetch\s*\(|DATABASE_URL|process\.env|stripe|redis|@\/db|checkout-sessions/i);
  });

  it("keeps English and Chinese message catalogs in exact key parity", () => {
    const en = JSON.parse(read("messages/en.json"));
    const zh = JSON.parse(read("messages/zh-CN.json"));
    expect(keys(en)).toEqual(keys(zh));
  });

  it("keeps only approved generated assets and the optimized sprite derivative", () => {
    expect(readdirSync(resolve(root, "public/demo")).sort()).toEqual(["datecn-hero.png", "profile-sprite-8.png", "profile-sprite-8.webp"]);
  });
});
