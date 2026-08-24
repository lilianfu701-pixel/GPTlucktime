"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { DemoProfile } from "@/modules/demo/demo-types";

import { ProfilePhoto } from "./profile-photo";

export function ProfileCard({ profile, locale, compact = false }: { profile: DemoProfile; locale: "en" | "zh"; compact?: boolean }) {
  const t = useTranslations("datecn");
  return <article className="group overflow-hidden rounded-[1.4rem] bg-white shadow-[0_16px_45px_rgba(81,35,43,.09)] ring-1 ring-[var(--datecn-ring)]" data-testid="demo-profile-card"><Link className="block" href={`/${locale}/demo/profile/${profile.id}`}><div className={`relative ${compact ? "aspect-[4/3]" : "aspect-[4/5]"}`}><ProfilePhoto className="absolute inset-0 transition-transform duration-500 group-hover:scale-[1.03]" name={profile.name} position={profile.spritePosition} /><div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" /><div className="absolute inset-x-0 bottom-0 p-4 text-white"><div className="flex items-center gap-2"><h3 className="text-xl font-semibold">{profile.name}, {profile.age}</h3>{profile.verified && <span aria-label={t("verified")} className="rounded-full bg-white/90 px-1.5 py-0.5 text-xs font-bold text-[var(--datecn-wine)]">✓</span>}</div><p className="mt-1 text-sm text-white/85">{profile.city}, {profile.country}</p></div></div><div className="p-4"><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-[var(--datecn-wine)]">{t("compatible", { value: profile.compatibility })}</span>{profile.online && <span className="text-xs font-medium text-emerald-700">● {t("online")}</span>}</div><p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--datecn-muted)]">{profile.bio}</p></div></Link></article>;
}
