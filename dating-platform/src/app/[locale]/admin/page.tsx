import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { resolveLocale } from "@/i18n/request";
import { adminService, readAdminPageSession } from "@/modules/admin/runtime";
import { hasPermission, requirePermission, requireRecentMfa } from "@/modules/admin/permissions";
import { ADMIN_QUEUE_PERMISSIONS, type AdminQueue } from "@/modules/admin/admin-service";

import { AdminModerationActions } from "./admin-moderation-actions";

const statusKeys = new Set(["pending", "processing", "approved", "rejected", "open", "resolved", "failed", "manual_review"]);

export default async function AdminPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  let session;
  try { session = await readAdminPageSession(await headers()); } catch { notFound(); }
  if (!session) notFound();
  try {
    requirePermission(session.role, "admin.console.read");
    requireRecentMfa(session);
  } catch { notFound(); }
  const query = await searchParams;
  const t = await getTranslations({ locale: resolvedLocale, namespace: "admin" });
  const allowed = (Object.keys(ADMIN_QUEUE_PERMISSIONS) as AdminQueue[])
    .filter((queue) => hasPermission(session.role, ADMIN_QUEUE_PERMISSIONS[queue]));
  if (allowed.length === 0) notFound();
  const rawQueue = typeof query.queue === "string" ? query.queue : allowed[0]!;
  if (!(rawQueue in ADMIN_QUEUE_PERMISSIONS) || !allowed.includes(rawQueue as AdminQueue)) notFound();
  const queue = rawQueue as AdminQueue;
  const rawLimit = typeof query.limit === "string" ? query.limit : "20";
  if (!/^\d{1,2}$/u.test(rawLimit)) notFound();
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 50) notFound();
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  let page;
  try { page = await adminService.listQueue(session, { queue, limit, ...(cursor ? { cursor } : {}) }); }
  catch { notFound(); }

  return (
    <main className="min-h-screen bg-stone-100 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <header className="rounded-3xl bg-stone-950 px-8 py-7 text-white shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-300">{t("eyebrow")}</p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-4xl font-semibold tracking-tight">{t("title")}</h1>
              <p className="mt-2 text-stone-300">{t("intro")}</p>
            </div>
            <nav aria-label={t("navigation")} className="flex gap-2 text-sm font-medium">
              {allowed.map((item) => <Link key={item} href={`/${locale}/admin?queue=${item}&limit=${limit}`}
                aria-current={item === queue ? "page" : undefined}
                className={item === queue ? "rounded-full bg-white px-4 py-2 text-stone-950"
                  : "rounded-full border border-stone-700 px-4 py-2 text-stone-300"}>
                {t(`queues.${item}`)}
              </Link>)}
            </nav>
          </div>
        </header>

        <section className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("authorizedQueues")}>
              <article className="rounded-3xl bg-white p-6 shadow-sm">
                <h2 className="text-xl font-semibold">{t(`queues.${queue}`)}</h2>
                {page.items.length === 0 ? (
                  <p className="mt-4 text-sm text-stone-500">{t("empty")}</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {page.items.map((item) => (
                      <li key={item.id} className="rounded-2xl bg-stone-50 p-4">
                        <p className="font-medium capitalize">{t(`status.${statusKeys.has(item.status) ? item.status : "unknown"}`)}</p>
                        <time className="mt-1 block text-xs text-stone-500" dateTime={item.createdAt}>
                          {new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt))}
                        </time>
                        <AdminModerationActions queue={queue} itemId={item.id} status={item.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {page.nextCursor && <Link className="mt-4 inline-flex rounded-full border border-stone-300 px-4 py-2 text-sm font-medium"
                  href={`/${locale}/admin?queue=${queue}&limit=${limit}&cursor=${encodeURIComponent(page.nextCursor)}`}>
                  {t("next")}
                </Link>}
              </article>
        </section>
      </div>
    </main>
  );
}
