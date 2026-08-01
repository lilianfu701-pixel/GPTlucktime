import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Temporary. Answers whether this runtime can localize a country name. */
export async function GET() {
  const sample: Record<string, string> = {};
  for (const locale of ["en", "zh-CN", "ja", "ar", "ru"]) {
    try {
      sample[locale] = new Intl.DisplayNames([locale], { type: "region" }).of(
        "IE",
      )!;
    } catch (error) {
      sample[locale] = `ERR ${(error as Error).message}`;
    }
  }

  return NextResponse.json({
    node: process.version,
    fullIcu: sample["zh-CN"] !== sample.en,
    sample,
  });
}
