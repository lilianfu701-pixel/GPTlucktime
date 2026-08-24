"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { DateCNIcon, type DateCNIconName } from "./datecn-icons";

export type DemoDestination = "discover" | "matches" | "messages" | "membership" | "me";
export const destinations: readonly DemoDestination[] = ["discover", "matches", "messages", "membership", "me"];

export function MobileNav({ locale, active }: { locale: "en" | "zh"; active: DemoDestination }) {
  const t = useTranslations("datecn.nav");
  return <nav aria-label={t("mobile")} className="datecn-mobile-nav lg:hidden">
    {destinations.map((item) => <Link aria-current={active === item ? "page" : undefined} className="datecn-nav-link" href={`/${locale}/demo/${item}`} key={item}><DateCNIcon name={item as DateCNIconName} /><span>{t(item)}</span></Link>)}
  </nav>;
}
