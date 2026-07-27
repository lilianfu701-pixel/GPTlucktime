import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const vercelConfigPath = resolve(process.cwd(), "vercel.json");

function readVercelConfig() {
  return JSON.parse(readFileSync(vercelConfigPath, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
}

describe("vercel routing", () => {
  test("routes /5 traffic to the Fantasy 5 site origin", () => {
    const config = readVercelConfig();

    expect(config.rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/5",
          destination: "https://fantasy5-research.zeximail.chatgpt.site/5",
        },
        {
          source: "/5/:path*",
          destination: "https://fantasy5-research.zeximail.chatgpt.site/:path*",
        },
      ]),
    );
  });
});
