"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import type { DemoProfile } from "@/modules/demo/demo-types";

import { ProfileCard } from "./profile-card";

export function DiscoverDemo({ locale, profiles }: { locale: "en" | "zh"; profiles: readonly DemoProfile[] }) {
  const t = useTranslations("datecn.discover");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | "online" | "verified">("all");
  const [expanded, setExpanded] = useState(false);
  const shown = useMemo(() => profiles.filter((profile) => {
    const textMatch = `${profile.name} ${profile.city} ${profile.country}`.toLowerCase().includes(query.trim().toLowerCase());
    return textMatch && (mode === "all" || (mode === "online" ? profile.online : profile.verified));
  }), [mode, profiles, query]);
  return <div><div className="flex flex-col gap-4 rounded-2xl bg-white p-4 ring-1 ring-[var(--datecn-ring)] sm:flex-row sm:items-center"><input aria-label={t("search")} className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--datecn-ring)] px-4" onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} type="search" value={query} /><button aria-expanded={expanded} className="datecn-ghost-button md:hidden" onClick={() => setExpanded((value) => !value)} type="button">{t("filters")}</button><div className={`${expanded ? "flex" : "hidden"} flex-wrap gap-2 md:flex`}>{(["all", "online", "verified"] as const).map((item) => <button aria-pressed={mode === item} className={`rounded-full px-4 py-2 text-sm font-semibold ${mode === item ? "bg-[var(--datecn-wine)] text-white" : "bg-[var(--datecn-cream)] text-[var(--datecn-muted)]"}`} key={item} onClick={() => setMode(item)} type="button">{t(item)}</button>)}</div></div><p className="my-5 text-sm font-medium text-[var(--datecn-muted)]">{t("showing", { count: shown.length })}</p>{shown.length ? <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{shown.map((profile) => <ProfileCard key={profile.id} locale={locale} profile={profile} />)}</div> : <div className="rounded-2xl bg-white p-10 text-center text-[var(--datecn-muted)] ring-1 ring-[var(--datecn-ring)]">{t("noResults")}</div>}</div>;
}
