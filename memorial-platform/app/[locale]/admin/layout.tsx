import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { currentActor } from "@/modules/auth/current-user";

export const dynamic = "force-dynamic";

export default async function AdminLayout(props: {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const actor = await currentActor();

  if (actor.platformRole === "user") {
    notFound();
  }

  const t = await getTranslations("admin");
  const isSuperAdmin = actor.platformRole === "super_admin";

  return (
    <div className="adminShell" data-testid="admin-surface">
      <nav className="adminSidebar" aria-label={t("navLabel")}>
        <div className="adminSidebarTitle">{t("title")}</div>
        <ul className="adminNav">
          <li>
            <Link href={`/${locale}/admin`} className="adminNavLink">
              {t("dashboard")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/reports`} className="adminNavLink">
              {t("reports")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/disputes`} className="adminNavLink">
              {t("disputes")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/rituals`} className="adminNavLink">
              {t("rituals")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/cases`} className="adminNavLink">
              {t("cases")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/users`} className="adminNavLink">
              {t("users")}
            </Link>
          </li>
          <li>
            <Link href={`/${locale}/admin/memorials`} className="adminNavLink">
              {t("memorials")}
            </Link>
          </li>
          {isSuperAdmin ? (
            <>
              <li>
                <Link
                  href={`/${locale}/admin/orders`}
                  className="adminNavLink"
                >
                  {t("orders")}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/admin/offerings`}
                  className="adminNavLink"
                >
                  {t("offerings")}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/admin/payouts`}
                  className="adminNavLink"
                >
                  {t("payouts")}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/admin/settings`}
                  className="adminNavLink"
                >
                  {t("settings")}
                </Link>
              </li>
              <li>
                <Link href={`/${locale}/admin/claims`} className="adminNavLink">
                  认领申请
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/admin/genealogy`}
                  className="adminNavLink"
                >
                  族谱导入
                </Link>
              </li>
            </>
          ) : null}
        </ul>
      </nav>
      <main id="main" className="adminContent">
        {props.children}
      </main>
    </div>
  );
}
