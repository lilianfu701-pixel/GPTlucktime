"use client";

import { useMemo, useState, type FormEvent } from "react";

type Locale = "en" | "zh";
type InitialProfile = Record<string, unknown> | null;

const copy = {
  en: {
    title: "Create a profile that feels like you",
    intro: "Share what matters to you. Your exact birth date and private settings are never shown publicly.",
    progress: "Profile completeness",
    name: "Display name",
    birthDate: "Birth date",
    gender: "Gender identity",
    genderHint: "Use the words that fit you, such as woman, man, nonbinary, or self_described.",
    goal: "Relationship goal",
    country: "Country code",
    city: "City",
    bio: "About you",
    languages: "Languages",
    interests: "Interests",
    listHint: "Separate entries with commas.",
    visible: "Let my approved profile appear in discovery",
    save: "Save and continue",
    saving: "Saving…",
    saved: "Profile saved.",
    photo: "Add a profile photo",
    photoHint: "JPEG, PNG, or WebP. Maximum 10 MiB. Photos remain private while review is pending.",
    uploading: "Uploading securely…",
    pending: "Uploaded. Review is pending; this photo is not public yet.",
    error: "We could not save that. Check the highlighted fields and try again.",
    photoError: "We could not upload that photo. Please choose another file and try again.",
    required: "This field is required.",
  },
  zh: {
    title: "创建真正属于你的个人资料",
    intro: "分享对你重要的事情。你的准确出生日期和隐私设置绝不会公开展示。",
    progress: "资料完整度",
    name: "显示名称",
    birthDate: "出生日期",
    gender: "性别认同",
    genderHint: "请使用适合你的表达，例如 woman、man、nonbinary 或 self_described。",
    goal: "关系期待",
    country: "国家代码",
    city: "城市",
    bio: "关于你",
    languages: "语言",
    interests: "兴趣",
    listHint: "请使用逗号分隔。",
    visible: "审核通过后允许我的资料出现在发现页面",
    save: "保存并继续",
    saving: "正在保存…",
    saved: "资料已保存。",
    photo: "添加个人照片",
    photoHint: "支持 JPEG、PNG 或 WebP，最大 10 MiB。审核期间照片保持私密。",
    uploading: "正在安全上传…",
    pending: "上传完成，正在审核；这张照片目前不会公开。",
    error: "暂时无法保存。请检查标出的字段后重试。",
    photoError: "暂时无法上传这张照片，请选择其他文件后重试。",
    required: "此字段为必填项。",
  },
} as const;

const stringValue = (profile: InitialProfile, key: string) =>
  typeof profile?.[key] === "string" ? profile[key] as string : "";
const listValue = (profile: InitialProfile, key: string) =>
  Array.isArray(profile?.[key]) ? (profile[key] as string[]).join(", ") : "";
const codes = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);

export default function OnboardingForm({ locale, initialProfile }: { locale: Locale; initialProfile: InitialProfile }) {
  const text = copy[locale];
  const [form, setForm] = useState({
    displayName: stringValue(initialProfile, "displayName"),
    birthDate: stringValue(initialProfile, "birthDate"),
    genderCode: stringValue(initialProfile, "genderCode"),
    relationshipGoalCode: stringValue(initialProfile, "relationshipGoalCode"),
    countryCode: stringValue(initialProfile, "countryCode"),
    city: stringValue(initialProfile, "city"),
    bio: stringValue(initialProfile, "bio"),
    languageCodes: listValue(initialProfile, "languageCodes"),
    interestCodes: listValue(initialProfile, "interestCodes"),
    discoverable: initialProfile?.discoverable !== false,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [photoStatus, setPhotoStatus] = useState<"idle" | "uploading" | "pending" | "error">("idle");

  const completeness = useMemo(() => {
    const values = [form.displayName, form.birthDate, form.genderCode, form.countryCode, form.city, form.bio, form.languageCodes, form.interestCodes];
    return Math.round(values.filter((value) => value.trim()).length / values.length * 100);
  }, [form]);

  const update = (field: keyof typeof form, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: "" }));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    for (const field of ["displayName", "birthDate", "genderCode", "countryCode"] as const) {
      if (!form[field].trim()) errors[field] = text.required;
    }
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setSaveStatus("error");
      return;
    }
    setSaveStatus("saving");
    const response = await fetch("/api/v1/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        relationshipGoalCode: form.relationshipGoalCode || null,
        city: form.city || null,
        bio: form.bio || null,
        countryCode: form.countryCode.toUpperCase(),
        languageCodes: codes(form.languageCodes),
        interestCodes: codes(form.interestCodes),
      }),
    }).catch(() => null);
    setSaveStatus(response?.ok ? "saved" : "error");
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoStatus("uploading");
    try {
      const reservation = await fetch("/api/v1/me/photos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mimeType: file.type,
          sizeBytes: file.size,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!reservation.ok) throw new Error("PHOTO_RESERVATION_FAILED");
      const upload = await reservation.json();
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error("PHOTO_PUT_FAILED");
      const completion = await fetch("/api/v1/me/photos/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: upload.uploadId, uploadToken: upload.uploadToken }),
      });
      if (!completion.ok) throw new Error("PHOTO_COMPLETION_FAILED");
      setPhotoStatus("pending");
    } catch {
      setPhotoStatus("error");
    }
  }

  const fieldClass = "mt-2 w-full rounded-2xl border border-rose-200 bg-white px-4 py-3 text-stone-900 outline-none focus:border-rose-600 focus:ring-2 focus:ring-rose-200";
  const labelClass = "block text-sm font-semibold text-stone-800";
  const errorFor = (field: string) => fieldErrors[field]
    ? <p id={`${field}-error`} className="mt-1 text-sm text-red-700">{fieldErrors[field]}</p>
    : null;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-rose-100 sm:p-10" onSubmit={submit} noValidate>
        <div className="grid gap-6 sm:grid-cols-2">
          <label className={labelClass}>{text.name}<input className={fieldClass} value={form.displayName} onChange={(e) => update("displayName", e.target.value)} aria-invalid={Boolean(fieldErrors.displayName)} aria-describedby="displayName-error" maxLength={80} required />{errorFor("displayName")}</label>
          <label className={labelClass}>{text.birthDate}<input className={fieldClass} type="date" value={form.birthDate} onChange={(e) => update("birthDate", e.target.value)} aria-invalid={Boolean(fieldErrors.birthDate)} aria-describedby="birthDate-error" required />{errorFor("birthDate")}</label>
          <label className={labelClass}>{text.gender}<input className={fieldClass} value={form.genderCode} onChange={(e) => update("genderCode", e.target.value)} aria-invalid={Boolean(fieldErrors.genderCode)} aria-describedby="gender-hint genderCode-error" maxLength={40} required /><span id="gender-hint" className="mt-1 block text-xs font-normal text-stone-500">{text.genderHint}</span>{errorFor("genderCode")}</label>
          <label className={labelClass}>{text.goal}<input className={fieldClass} value={form.relationshipGoalCode} onChange={(e) => update("relationshipGoalCode", e.target.value)} maxLength={40} /></label>
          <label className={labelClass}>{text.country}<input className={fieldClass} value={form.countryCode} onChange={(e) => update("countryCode", e.target.value)} aria-invalid={Boolean(fieldErrors.countryCode)} aria-describedby="countryCode-error" maxLength={2} autoCapitalize="characters" required />{errorFor("countryCode")}</label>
          <label className={labelClass}>{text.city}<input className={fieldClass} value={form.city} onChange={(e) => update("city", e.target.value)} maxLength={120} /></label>
          <label className={`${labelClass} sm:col-span-2`}>{text.bio}<textarea className={`${fieldClass} min-h-32 resize-y`} value={form.bio} onChange={(e) => update("bio", e.target.value)} maxLength={2000} /></label>
          <label className={labelClass}>{text.languages}<input className={fieldClass} value={form.languageCodes} onChange={(e) => update("languageCodes", e.target.value)} aria-describedby="list-hint" /><span id="list-hint" className="mt-1 block text-xs font-normal text-stone-500">{text.listHint}</span></label>
          <label className={labelClass}>{text.interests}<input className={fieldClass} value={form.interestCodes} onChange={(e) => update("interestCodes", e.target.value)} aria-describedby="list-hint" /></label>
        </div>
        <label className="mt-6 flex items-start gap-3 text-sm text-stone-700"><input className="mt-1 size-4 accent-rose-700" type="checkbox" checked={form.discoverable} onChange={(e) => update("discoverable", e.target.checked)} />{text.visible}</label>
        <button className="mt-8 rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800 disabled:cursor-wait disabled:opacity-60" disabled={saveStatus === "saving"}>{saveStatus === "saving" ? text.saving : text.save}</button>
        <div className="mt-3 min-h-6 text-sm" role="status" aria-live="polite">{saveStatus === "saved" ? <span className="text-emerald-700">{text.saved}</span> : saveStatus === "error" ? <span className="text-red-700">{text.error}</span> : null}</div>
      </form>

      <aside className="space-y-6">
        <section className="rounded-3xl bg-rose-900 p-6 text-white">
          <div className="flex items-center justify-between text-sm"><span>{text.progress}</span><strong>{completeness}%</strong></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20" role="progressbar" aria-label={text.progress} aria-valuenow={completeness} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-rose-200 transition-[width]" style={{ width: `${completeness}%` }} /></div>
        </section>
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-rose-100">
          <h2 className="text-lg font-semibold">{text.photo}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">{text.photoHint}</p>
          <label className="mt-5 block cursor-pointer rounded-2xl border border-dashed border-rose-300 bg-rose-50 px-4 py-8 text-center text-sm font-semibold text-rose-800 hover:bg-rose-100">
            {text.photo}
            <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={photoStatus === "uploading"} onChange={(e) => uploadPhoto(e.target.files?.[0])} />
          </label>
          <div className="mt-3 min-h-10 text-sm leading-6" role="status" aria-live="polite">{photoStatus === "uploading" ? text.uploading : photoStatus === "pending" ? <span className="text-emerald-700">{text.pending}</span> : photoStatus === "error" ? <span className="text-red-700">{text.photoError}</span> : null}</div>
        </section>
      </aside>
    </div>
  );
}
