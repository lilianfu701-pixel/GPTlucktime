"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { DemoPlan } from "@/modules/demo/demo-types";

export function MembershipDemo({ plans }: { plans: readonly DemoPlan[] }) {
  const t = useTranslations("datecn.membership");
  const [notice, setNotice] = useState("");
  return <><div className="grid gap-5 lg:grid-cols-3">{plans.map((plan) => <article className={`relative rounded-3xl bg-white p-6 shadow-sm ring-1 ${plan.recommended ? "ring-2 ring-[var(--datecn-gold)]" : "ring-[var(--datecn-ring)]"}`} key={plan.id}>{plan.recommended && <span className="absolute right-5 top-5 rounded-full bg-[var(--datecn-gold)] px-3 py-1 text-xs font-bold text-white">{t("recommended")}</span>}<h2 className="text-2xl font-bold">{plan.name}</h2><p className="mt-2 text-[var(--datecn-muted)]">{plan.description}</p><p className="my-6"><strong className="text-4xl text-[var(--datecn-wine)]">{plan.price}</strong><span className="text-sm text-[var(--datecn-muted)]">{t("month")}</span></p><ul className="space-y-3">{plan.features.map((feature) => <li className="flex gap-2 text-sm" key={feature}><span className="text-[var(--datecn-gold)]">✓</span>{feature}</li>)}</ul><button className={`mt-8 w-full ${plan.recommended ? "datecn-primary-button" : "datecn-ghost-button"}`} data-demo-action onClick={() => setNotice(t("notice"))} type="button">{t("choose", { plan: plan.name })}</button></article>)}</div><p className="mt-5 min-h-6 text-center text-sm font-semibold text-[var(--datecn-wine)]" role="status">{notice}</p></>;
}
