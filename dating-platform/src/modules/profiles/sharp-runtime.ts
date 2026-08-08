import { getSharp } from "next/dist/server/image-optimizer.js";

export type ProfileImageMetadata = {
  format?: string;
  width?: number;
  height?: number;
  pages?: number;
  pageHeight?: number;
};

export type ProfileSharpPipeline = {
  clone(): ProfileSharpPipeline;
  metadata(): Promise<ProfileImageMetadata>;
  jpeg(): ProfileSharpPipeline;
  png(): ProfileSharpPipeline;
  webp(): ProfileSharpPipeline;
  toBuffer(): Promise<Buffer>;
};

export type ProfileSharp = (
  input: Uint8Array | { create: { width: number; height: number; channels: 3 | 4; background: string } },
  options?: Record<string, unknown>,
) => ProfileSharpPipeline;

export function getProfileSharp(loader: typeof getSharp = getSharp): ProfileSharp {
  try {
    return loader(null, false) as unknown as ProfileSharp;
  } catch {
    throw new Error("IMAGE_PROCESSOR_UNAVAILABLE");
  }
}
