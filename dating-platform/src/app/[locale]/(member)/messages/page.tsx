import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { isSupportedLocale } from "@/i18n/locales";
import { auth } from "@/modules/auth/auth";
import { readEnv } from "@/shared/env";

import { MessagesClient } from "./messages-client";

export default async function MessagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const env = readEnv(process.env);
  return <MessagesClient locale={locale} realtimeUrl={env.REALTIME_PUBLIC_URL ?? null} />;
}
