import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Memorial platform",
  description:
    "A private-by-choice space for families to preserve and share a life.",
};

/**
 * Root layout. Locale-aware layouts live under `app/[locale]/` and set their own
 * `lang` and `dir`; this shell only exists so non-localized routes still render.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
