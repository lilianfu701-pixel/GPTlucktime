import { z } from "zod";

const emailSchema = z.string().email().max(254);

export function canonicalizeFreeTestEmail(value: string): string | null {
  if (value !== value.trim() || !emailSchema.safeParse(value).success) return null;
  const canonical = value.toLowerCase();
  const separator = canonical.lastIndexOf("@");
  return separator > 0 && canonical.slice(separator + 1) === "datecn.test" ? canonical : null;
}
