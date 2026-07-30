import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { currentActor } from "@/modules/auth/current-user";
import {
  disputeQueue,
  queueCounts,
  reportQueue,
  ritualReviewQueue,
} from "@/modules/governance/admin-queries";

/**
 * The moderation surface.
 *
 * Answers 404 to anyone who is not staff, before a single query runs. Two
 * reasons for the order and the status code:
 *
 * A count is information. "How many complaints are open" is not something a
 * stranger should be able to learn from a page that only refuses them
 * afterwards, so the guard comes first.
 *
 * 404 rather than 403, because 403 confirms the surface exists and is worth
 * probing. Doc 06 section 9 lists administrator abuse among the threats, and a
 * page that announces itself is where that starts.
 */
export const dynamic = "force-dynamic";

export default async function AdminPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const actor = await currentActor();

  // Before any query.
  if (actor.platformRole === "user") {
    notFound();
  }

  const counts = await queueCounts(actor);
  const reports = await reportQueue(actor, { limit: 25 });
  const disputes = await disputeQueue(actor, { limit: 25 });
  const rituals = await ritualReviewQueue(actor, { limit: 25 });

  if (!counts.ok || !reports.ok || !disputes.ok || !rituals.ok) {
    notFound();
  }

  const isSuperAdmin = actor.platformRole === "super_admin";

  return (
    <main id="main" data-testid="admin-surface">
      <h1>Moderation</h1>

      <section aria-labelledby="counts-heading">
        <h2 id="counts-heading">Waiting</h2>
        <ul>
          <li data-testid="count-reports">
            Reports: {counts.value.openReports}
          </li>
          <li data-testid="count-disputes">
            Ownership claims: {counts.value.openDisputes}
          </li>
          <li data-testid="count-rituals">
            Ritual revisions: {counts.value.ritualsAwaitingReview}
          </li>
        </ul>
      </section>

      <section aria-labelledby="reports-heading" data-testid="queue-reports">
        <h2 id="reports-heading">Reports</h2>
        <ul>
          {reports.value.map((report) => (
            <li key={report.id}>
              {report.category} on {report.resourceType} — {report.status}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="disputes-heading" data-testid="queue-disputes">
        <h2 id="disputes-heading">Ownership claims</h2>
        <ul>
          {disputes.value.map((dispute) => (
            <li key={dispute.id}>
              {dispute.claimedRelationship} — {dispute.status} —{" "}
              {dispute.evidenceCount} document(s)
              {/* Only the count. Opening a document is a separate, audited action. */}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="rituals-heading" data-testid="queue-rituals">
        <h2 id="rituals-heading">Ritual revisions</h2>
        <ul>
          {rituals.value.map((ritual) => (
            <li key={ritual.id}>
              Version {ritual.version} — {ritual.status} —{" "}
              {ritual.hasReviewer ? "reviewed" : "not yet reviewed"}
            </li>
          ))}
        </ul>
      </section>

      {isSuperAdmin ? (
        <section
          aria-labelledby="publishing-heading"
          data-testid="super-admin-only"
        >
          <h2 id="publishing-heading">Publishing</h2>
          <p>
            Publishing a ritual revision requires a stated reason. A revision
            cannot be published without a source, an applicability scope, a named
            reviewer and a human-reviewed translation.
          </p>
        </section>
      ) : null}
    </main>
  );
}
