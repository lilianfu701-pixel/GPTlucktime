import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";

import { PrivacyExportDownloadClient } from "./download-client";

export default async function PrivacyExportDownloadPage({ params }: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { locale, jobId } = await params;
  const resolvedLocale = resolveLocale(locale);
  const brand = await getTranslations({ locale: resolvedLocale, namespace: "brand" });
  return <main className="min-h-screen bg-rose-50 px-6 py-10 text-stone-900">
    <section className="mx-auto max-w-xl rounded-3xl bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p>
      <PrivacyExportDownloadClient locale={resolvedLocale} jobId={jobId} />
    </section>
  </main>;
}
