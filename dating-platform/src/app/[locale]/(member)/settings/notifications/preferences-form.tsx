"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

type Preferences = { locale: "en" | "zh-CN"; timeZone: string; marketingEnabled: boolean; emailEnabled: boolean;
  smsEnabled: boolean; inAppEnabled: boolean; quietStartHour: number | null; quietEndHour: number | null };

export function NotificationPreferencesForm({ initial }: { initial: Preferences }) {
  const t = useTranslations("notificationSettings");
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const toggle = (key: "marketingEnabled" | "emailEnabled" | "smsEnabled" | "inAppEnabled") =>
    setValue((current) => ({ ...current, [key]: !current[key] }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setStatus("saving");
    try {
      const response = await fetch("/api/v1/me/notification-preferences", { method: "PATCH",
        headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      if (!response.ok) throw new Error("PREFERENCES_UPDATE_FAILED");
      const result = await response.json() as { data: { preferences: Preferences } };
      setValue(result.data.preferences); setStatus("saved");
    } catch { setStatus("error"); }
  };
  return <form className="mt-8 space-y-6" onSubmit={submit}>
    <label className="block"><span className="block text-sm font-medium">{t("locale")}</span>
      <select className="mt-2 w-full rounded-xl border p-3" value={value.locale}
        onChange={(event) => setValue((current) => ({ ...current, locale: event.target.value as Preferences["locale"] }))}>
        <option value="en">{t("languages.en")}</option><option value="zh-CN">{t("languages.zh-CN")}</option>
      </select></label>
    <label className="block"><span className="block text-sm font-medium">{t("timeZone")}</span>
      <input className="mt-2 w-full rounded-xl border p-3" value={value.timeZone} maxLength={100}
        onChange={(event) => setValue((current) => ({ ...current, timeZone: event.target.value }))} /></label>
    <fieldset className="space-y-3"><legend className="font-medium">{t("channels")}</legend>
      {(["emailEnabled", "smsEnabled", "inAppEnabled", "marketingEnabled"] as const).map((key) =>
        <label className="flex items-center gap-3" key={key}><input type="checkbox" checked={value[key]}
          onChange={() => toggle(key)} /><span>{t(key)}</span></label>)}</fieldset>
    <fieldset className="space-y-3"><legend className="font-medium">{t("quietHours")}</legend>
      <label className="flex items-center gap-3"><input type="checkbox"
        checked={value.quietStartHour !== null && value.quietEndHour !== null}
        onChange={(event) => setValue((current) => event.target.checked
          ? { ...current, quietStartHour: 22, quietEndHour: 8 }
          : { ...current, quietStartHour: null, quietEndHour: null })} />
        <span>{t("quietHoursEnabled")}</span></label>
      <div className="grid grid-cols-2 gap-4">
        {(["quietStartHour", "quietEndHour"] as const).map((key) => <label key={key} className="block">
          <span className="block text-sm font-medium">{t(key)}</span>
          <input type="number" min={0} max={23} required value={value[key] ?? ""}
            disabled={value.quietStartHour === null || value.quietEndHour === null}
            className="mt-2 w-full rounded-xl border p-3"
            onChange={(event) => setValue((current) => ({ ...current, [key]: Number(event.target.value) }))} />
        </label>)}</div>
      <p className="text-sm text-stone-600">{t("quietHoursHelp")}</p>
    </fieldset>
    <button className="rounded-xl bg-rose-700 px-5 py-3 font-medium text-white" disabled={status === "saving"}>
      {t(status === "saving" ? "saving" : "save")}</button>
    {status === "saved" && <p role="status" className="text-sm text-emerald-700">{t("saved")}</p>}
    {status === "error" && <p role="alert" className="text-sm text-red-700">{t("error")}</p>}
  </form>;
}
