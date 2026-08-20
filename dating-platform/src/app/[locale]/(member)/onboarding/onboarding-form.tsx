"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

type InitialProfile = Record<string, unknown> | null;
type SafePhoto = {
  id: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};

const stringValue = (profile: InitialProfile, key: string) =>
  typeof profile?.[key] === "string" ? profile[key] as string : "";
const listValue = (profile: InitialProfile, key: string) =>
  Array.isArray(profile?.[key]) ? (profile[key] as string[]).join(", ") : "";
const codes = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);

export default function OnboardingForm({
  initialProfile,
  initialPhotos = [],
}: {
  initialProfile: InitialProfile;
  initialPhotos?: SafePhoto[];
}) {
  const t = useTranslations("onboarding");
  const text = new Proxy({} as Record<string, string>, { get: (_target, key) => t(String(key)) });
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
    timeZone: stringValue(initialProfile, "timeZone") || Intl.DateTimeFormat().resolvedOptions().timeZone,
    publish: initialProfile?.publishRequested === true,
  });
  const [photos, setPhotos] = useState<SafePhoto[]>(initialPhotos);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [photoStatus, setPhotoStatus] = useState<"idle" | "uploading" | "pending" | "error">("idle");
  const hasPendingPhoto = photos.some((photo) => photo.status === "pending");

  useEffect(() => {
    if (!hasPendingPhoto) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch("/api/v1/me/photos", { method: "GET" });
        if (!response.ok) return;
        const body = await response.json() as { photos?: SafePhoto[] };
        if (active && Array.isArray(body.photos)) setPhotos(body.photos);
      } catch {
        // The next bounded poll retries without exposing provider or storage details.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasPendingPhoto]);

  const completeness = useMemo(() => {
    const values = [form.displayName, form.birthDate, form.genderCode, form.countryCode, form.city, form.bio, form.languageCodes, form.interestCodes, form.timeZone];
    return Math.round(values.filter((value) => value.trim()).length / values.length * 100);
  }, [form]);

  const update = (field: keyof typeof form, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: "" }));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (form.publish) {
      for (const field of ["displayName", "birthDate", "genderCode", "countryCode"] as const) {
        if (!form[field].trim()) errors[field] = text.required;
      }
    }
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setSaveStatus("error");
      return;
    }
    setSaveStatus("saving");
    const payload: Record<string, unknown> = {
      relationshipGoalCode: form.relationshipGoalCode || null,
      city: form.city || null,
      bio: form.bio || null,
      timeZone: form.timeZone,
      languageCodes: codes(form.languageCodes),
      interestCodes: codes(form.interestCodes),
      publish: form.publish,
    };
    if (form.displayName.trim()) payload.displayName = form.displayName;
    if (form.birthDate.trim()) payload.birthDate = form.birthDate;
    if (form.genderCode.trim()) payload.genderCode = form.genderCode;
    if (form.countryCode.trim()) payload.countryCode = form.countryCode.toUpperCase();
    const response = await fetch("/api/v1/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
      const completed = await completion.json() as { photo: SafePhoto };
      setPhotos((current) => [completed.photo, ...current.filter((photo) => photo.id !== completed.photo.id)]);
      setPhotoStatus("pending");
    } catch {
      setPhotoStatus("error");
    }
  }

  async function removePhoto(photoId: string) {
    const response = await fetch("/api/v1/me/photos", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photoId }),
    }).catch(() => null);
    if (response?.ok) setPhotos((current) => current.filter((photo) => photo.id !== photoId));
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
        <label className="mt-6 flex items-start gap-3 text-sm text-stone-700"><input className="mt-1 size-4 accent-rose-700" type="checkbox" checked={form.publish} onChange={(e) => update("publish", e.target.checked)} />{text.visible}</label>
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
          {photos.length > 0 ? <ul className="mt-4 space-y-3">
            {photos.map((photo) => <li className="rounded-2xl border border-rose-100 p-3 text-sm" key={photo.id}>
              {photo.status === "pending" ? <span>{text.photoPending}</span> : null}
              {photo.status === "approved" ? <span>{text.photoApproved}</span> : null}
              {photo.status === "rejected" ? <div className="flex items-center justify-between gap-3">
                <span>{text.photoRejected}</span>
                <button className="rounded-full border border-rose-300 px-3 py-1 text-rose-800" type="button" aria-label={text.removeRejected} onClick={() => removePhoto(photo.id)}>{text.remove}</button>
              </div> : null}
            </li>)}
          </ul> : null}
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
