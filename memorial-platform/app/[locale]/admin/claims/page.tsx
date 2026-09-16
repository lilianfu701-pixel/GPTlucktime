import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { currentActor } from "@/modules/auth/current-user";
import { listAllPendingClaims } from "@/modules/memorials/ownership";
import { AdminClaims } from "./admin-claims";

export const dynamic = "force-dynamic";

/**
 * The claims queue — pending 认领/参与 requests across all pages, for staff to
 * answer. Seeded pages are owned by a bot steward that never signs in, so this
 * is the only place their claims get seen and decided.
 */
export default async function AdminClaimsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const actor = await currentActor();
  if (actor.platformRole !== "super_admin") {
    notFound();
  }

  const claims = await listAllPendingClaims();

  return (
    <div className="stack-lg">
      <h1>认领申请</h1>
      <p className="muted measure">
        全站待处理的「认领」（转移拥有权）与「参与」（加为管理者）申请。代建/导入的先人页由平台账户代管，其认领申请在此审批。通过认领后，页面归属转给申请人。
      </p>
      <AdminClaims initial={claims} locale={locale} />
    </div>
  );
}
