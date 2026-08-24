"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

type SiteHeaderLabels = Readonly<{
  brand: string;
  language: string;
  signIn: string;
}>;

function LocaleSwitch({ locale, label }: { locale: "en" | "zh"; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const other = locale === "en" ? "zh" : "en";
  const segments = (pathname || `/${locale}`).split("/");
  segments[1] = other;
  const query = searchParams.toString();
  const href = `${segments.join("/")}${query ? `?${query}` : ""}`;
  return <Link className="datecn-ghost-button" href={href}>{label}</Link>;
}

export function SiteHeader({ locale, labels, member = false }: { locale: "en" | "zh"; labels: SiteHeaderLabels; member?: boolean }) {
  return <header className="border-b border-[var(--datecn-ring)] bg-white/95"><div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6"><Link className="font-serif text-2xl font-bold tracking-tight text-[var(--datecn-wine)]" href={`/${locale}`}>{labels.brand}</Link><div className="flex items-center gap-2"><Suspense fallback={<span className="datecn-ghost-button">{labels.language}</span>}><LocaleSwitch label={labels.language} locale={locale} /></Suspense>{!member && <Link className="datecn-primary-button hidden sm:inline-flex" href={`/${locale}/sign-in`}>{labels.signIn}</Link>}</div></div></header>;
}
