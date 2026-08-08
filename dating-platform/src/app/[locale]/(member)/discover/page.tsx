import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/infrastructure/db/client";
import { isSupportedLocale } from "@/i18n/locales";
import { auth } from "@/modules/auth/auth";
import { DiscoveryRepository } from "@/modules/discovery/discovery-repository";
import { DISCOVERY_MODES, publicDiscoveryFilterSchema, type DiscoveryMode } from "@/modules/discovery/discovery-types";
import { readEnv } from "@/shared/env";

const labels: Record<DiscoveryMode, { en: string; zh: string }> = {
  recommended: { en: "Recommended", zh: "为你推荐" },
  new: { en: "New", zh: "新加入" },
  nearby: { en: "Nearby", zh: "附近" },
  online: { en: "Online", zh: "在线" },
  verified: { en: "Verified", zh: "已认证" },
};

export default async function DiscoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isSupportedLocale(locale)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const mode = DISCOVERY_MODES.includes(query.mode as DiscoveryMode)
    ? query.mode as DiscoveryMode
    : "recommended";
  const env = readEnv(process.env);
  const result = await new DiscoveryRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
  }).discover(session.user.id, publicDiscoveryFilterSchema.parse({ mode, pageSize: 20 }));
  const zh = locale === "zh";

  return (
    <main className="min-h-screen bg-rose-50 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">Heartline</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">
          {zh ? "发现真诚的连接" : "Discover genuine connections"}
        </h1>
        <p className="mt-3 max-w-2xl text-stone-600">
          {zh ? "推荐只会展示符合双方偏好与安全规则的公开资料。" : "Every result respects mutual preferences, privacy, and safety rules."}
        </p>
        <nav className="mt-8 flex flex-wrap gap-2" aria-label={zh ? "发现模式" : "Discovery modes"}>
          {DISCOVERY_MODES.map((item) => (
            <Link
              key={item}
              href={`/${locale}/discover?mode=${item}`}
              aria-current={item === mode ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm font-medium ${item === mode ? "bg-rose-700 text-white" : "bg-white text-stone-700"}`}
            >
              {labels[item][zh ? "zh" : "en"]}
            </Link>
          ))}
        </nav>
        {result.items.length === 0 ? (
          <section className="mt-10 rounded-3xl bg-white p-10 text-center" aria-live="polite">
            <h2 className="text-xl font-semibold">{zh ? "暂时没有合适的推荐" : "No matches here yet"}</h2>
            <p className="mt-2 text-stone-600">{zh ? "稍后再来看看，或尝试其他发现模式。" : "Check back later or try another discovery mode."}</p>
          </section>
        ) : (
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-label={zh ? "推荐资料" : "Recommended profiles"}>
            {result.items.map((raw) => {
              const item = raw as Record<string, unknown>;
              const reasons = Array.isArray(item.reasons) ? item.reasons.filter((reason): reason is string => typeof reason === "string") : [];
              return (
                <li key={String(item.id)}>
                  <article className="h-full rounded-3xl bg-white p-6 shadow-sm">
                    <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-rose-100 text-rose-700" aria-hidden="true">
                      ♥
                    </div>
                    <h2 className="mt-5 text-2xl font-semibold">
                      {String(item.displayName ?? (zh ? "匿名用户" : "Member"))}
                      {typeof item.age === "number" ? `, ${item.age}` : ""}
                    </h2>
                    <p className="mt-1 text-sm text-stone-500">
                      {[item.city, item.countryCode].filter((value): value is string => typeof value === "string").join(", ")}
                    </p>
                    {typeof item.bio === "string" && <p className="mt-4 line-clamp-3 text-stone-700">{item.bio}</p>}
                    {reasons.length > 0 && (
                      <p className="mt-4 text-sm font-medium text-rose-700">
                        {zh ? "推荐理由：" : "Why this match: "}{reasons.map((reason) => reason.replaceAll("_", " ")).join(" · ")}
                      </p>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
