import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/modules/auth/auth";
import { readEnv } from "@/shared/env";

import { MessagesClient } from "./messages-client";

export default async function MessagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const env = readEnv(process.env);
  return <MessagesClient realtimeUrl={env.REALTIME_PUBLIC_URL ?? null} />;
}
