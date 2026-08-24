import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { db } from "@/infrastructure/db/client";
import { resolveLocale } from "@/i18n/request";
import { auth } from "@/modules/auth/auth";
import { DISCOVERY_MODES, publicDiscoveryFilterSchema, type DiscoveryMode } from "@/modules/discovery/discovery-types";
import { createProductionDiscoveryRepository } from "@/modules/discovery/runtime";
import { readEnv } from "@/shared/env";

import { DiscoverActions } from "./discover-actions";

const reasonKeys = new Set(["shared_interests", "same_country", "recently_active", "identity_verified"]);

export default async function DiscoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  const resolvedLocale = resolveLocale(locale);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/${locale}/sign-in`);
  const mode = DISCOVERY_MODES.includes(query.mode as DiscoveryMode)
    ? query.mode as DiscoveryMode
    : "recommended";
  const env = readEnv(process.env);
  const result = await createProductionDiscoveryRepository(db, {
    cursorSecret: env.BETTER_AUTH_SECRET,
    disabledCountryCodes: env.DISCOVERY_DISABLED_COUNTRY_CODES?.split(","),
  }).discover(session.user.id, publicDiscoveryFilterSchema.parse({ mode, pageSize: 20 }));
  const [t, brand] = await Promise.all([
    getTranslations({ locale: resolvedLocale, namespace: "discover" }),
    getTranslations({ locale: resolvedLocale, namespace: "brand" }),
  ]);

  return (
    <main className="min-h-screen bg-rose-50 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-700">{brand("name")}</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-2xl text-stone-600">
          {t("intro")}
        </p>
        <nav className="mt-8 flex flex-wrap gap-2" aria-label={t("navigation")}>
          {DISCOVERY_MODES.map((item) => (
            <Link
              key={item}
              href={`/${locale}/discover?mode=${item}`}
              aria-current={item === mode ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm font-medium ${item === mode ? "bg-rose-700 text-white" : "bg-white text-stone-700"}`}
            >
              {t(`modes.${item}`)}
            </Link>
          ))}
        </nav>
        {result.items.length === 0 ? (
          <section className="mt-10 rounded-3xl bg-white p-10 text-center" aria-live="polite">
            <h2 className="text-xl font-semibold">{t("emptyTitle")}</h2>
            <p className="mt-2 text-stone-600">{t("emptyDescription")}</p>
          </section>
        ) : (
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("results")}>
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
                      {String(item.displayName ?? t("member"))}
                      {typeof item.age === "number" ? `, ${item.age}` : ""}
                    </h2>
                    <p className="mt-1 text-sm text-stone-500">
                      {[item.city, item.countryCode].filter((value): value is string => typeof value === "string").join(", ")}
                    </p>
                    {typeof item.bio === "string" && <p className="mt-4 line-clamp-3 text-stone-700">{item.bio}</p>}
                    {reasons.length > 0 && (
                      <p className="mt-4 text-sm font-medium text-rose-700">
                        {t("reasonLabel", { reasons: reasons.map((reason) => t(`reasons.${reasonKeys.has(reason) ? reason : "other"}`)).join(" · ") })}
                      </p>
                    )}
                    <DiscoverActions locale={resolvedLocale === "zh-CN" ? "zh" : "en"}
                      profileId={String(item.id)} displayName={String(item.displayName ?? t("member"))} />
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
