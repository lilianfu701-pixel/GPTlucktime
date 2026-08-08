// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../../src", import.meta.url));
const entitlementRoot = join(sourceRoot, "modules", "entitlements");

describe("entitlement module boundary", () => {
  it("keeps repository authority private to the entitlement module", async () => {
    const names = await readdir(sourceRoot, { recursive: true });
    const violations: string[] = [];
    for (const name of names.filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))) {
      const absolute = join(sourceRoot, name);
      if (absolute.startsWith(entitlementRoot)) continue;
      const source = await readFile(absolute, "utf8");
      if (/usage-repository|entitlementRepository|ResolvedConsumeEntitlementInput|consumeResolvedInTransaction/.test(source)) {
        violations.push(name);
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not export the repository singleton or resolved consume input", async () => {
    const runtime = await readFile(join(entitlementRoot, "runtime.ts"), "utf8");
    const types = await readFile(join(entitlementRoot, "types.ts"), "utf8");
    expect(runtime).not.toMatch(/export\s+const\s+entitlementRepository/);
    expect(types).not.toMatch(/export\s+type\s+ResolvedConsumeEntitlementInput/);
  });
});
