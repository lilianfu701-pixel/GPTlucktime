"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

const actions = ["notifications", "privacy", "security"] as const;

export function MeDemoActions() {
  const t = useTranslations("datecn.me");
  const [message, setMessage] = useState("");
  return <div className="mt-4"><div className="space-y-2">{actions.map((key) => <button className="flex min-h-12 w-full items-center justify-between rounded-xl bg-[var(--datecn-cream)] px-4 text-left" data-demo-action key={key} onClick={() => setMessage(t("actionNotice", { action: t(key) }))} type="button"><span>{t(key)}</span><span aria-hidden>→</span></button>)}</div><p aria-live="polite" className="mt-4 min-h-5 text-xs font-semibold text-[var(--datecn-wine)]" role="status">{message}</p></div>;
}
