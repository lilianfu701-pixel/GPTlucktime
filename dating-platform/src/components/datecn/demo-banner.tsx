"use client";

import { useTranslations } from "next-intl";

export function DemoBanner() {
  const t = useTranslations("datecn");
  return <aside className="bg-[var(--datecn-wine-deep)] px-4 py-2 text-center text-xs font-medium text-white" role="note"><strong>{t("demoMode")}</strong><span className="mx-2 opacity-60">•</span>{t("demoNotice")}</aside>;
}
