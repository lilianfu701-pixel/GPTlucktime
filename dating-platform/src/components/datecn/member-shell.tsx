"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { DateCNIcon } from "./datecn-icons";
import { DemoBanner } from "./demo-banner";
import { destinations, MobileNav, type DemoDestination } from "./mobile-nav";
import { SiteHeader } from "./site-header";

export function MemberShell({ children, locale, active }: { children: ReactNode; locale: "en" | "zh"; active: DemoDestination }) {
  const t = useTranslations("datecn.nav");
  const datecn = useTranslations("datecn");
  const brand = useTranslations("brand");
  const labels = { brand: brand("name"), language: datecn("language"), signIn: datecn("signIn") };
  return <div className="min-h-screen bg-[var(--datecn-cream)]"><DemoBanner /><SiteHeader labels={labels} locale={locale} member /><div className="mx-auto flex max-w-7xl"><aside className="hidden w-56 shrink-0 border-r border-[var(--datecn-ring)] bg-white/70 p-5 lg:block"><nav aria-label={t("member")} className="sticky top-5 space-y-1">{destinations.map((item) => <Link aria-current={active === item ? "page" : undefined} className="datecn-sidebar-link" href={`/${locale}/demo/${item}`} key={item}><DateCNIcon name={item} />{t(item)}</Link>)}</nav></aside><main className="min-w-0 flex-1 px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-10">{children}</main></div><MobileNav active={active} locale={locale} /></div>;
}
