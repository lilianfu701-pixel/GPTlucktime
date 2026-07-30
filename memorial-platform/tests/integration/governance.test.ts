import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import {
  auditLogs,
  commemorations,
  deceasedPeople,
  disputeEvidence,
  memorialMembers,
  memorialNames,
  memorialSlugRedirects,
  memorials,
  moderationActions,
  moderationCases,
  outboxEvents,
  ownershipDisputes,
  reports,
  users,
} from "@/db/schema";
import { resolveAccessById } from "@/modules/memorials/access";
import { changePrivacy } from "@/modules/memorials/privacy";
import { createMemorial } from "@/modules/memorials/service";
import {
  accessEvidence,
  appealDispute,
  attachEvidence,
  decideDispute,
  isOwnershipFrozen,
  openOwnershipDispute,
} from "@/modules/governance/disputes";
import {
  mergeDuplicateMemorials,
  resolveSlugRedirect,
} from "@/modules/governance/merge";
import {
  applyRestriction,
  openCase,
  restoreMemorial,
  setCaseStatus,
  submitReport,
} from "@/modules/governance/reports";
import type { Actor } from "@/modules/permissions/types";

const createdUserIds: string[] = [];
let reviewer: Actor;
let superAdmin: Actor;

beforeAll(async () => {
  expect(process.env.DATABASE_URL ?? "").toContain("_test");

  const [staff] = await db()
    .insert(users)
    .values({ displayName: "Platform reviewer" })
    .returning({ id: users.id });
  const [admin] = await db()
    .insert(users)
    .values({ displayName: "Super admin" })
    .returning({ id: users.id });
  if (!staff || !admin) throw new Error("user insert returned no row");

  reviewer = { userId: staff.id, platformRole: "reviewer" };
  superAdmin = { userId: admin.id, platformRole: "super_admin" };
});

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length === 0) return;

  const owned = await db()
    .select({ id: memorials.id, personId: memorials.deceasedPersonId })
    .from(memorials)
    .where(inArray(memorials.ownerUserId, userIds));
  const memorialIds = owned.map((row) => row.id);

  if (memorialIds.length > 0) {
    const disputes = await db()
      .select({ id: ownershipDisputes.id })
      .from(ownershipDisputes)
      .where(inArray(ownershipDisputes.memorialId, memorialIds));
    if (disputes.length > 0) {
      await db()
        .delete(disputeEvidence)
        .where(inArray(disputeEvidence.disputeId, disputes.map((r) => r.id)));
    }
    await db()
      .delete(ownershipDisputes)
      .where(inArray(ownershipDisputes.memorialId, memorialIds));
    await db()
      .delete(moderationActions)
      .where(inArray(moderationActions.resourceId, memorialIds));
    await db()
      .delete(moderationCases)
      .where(inArray(moderationCases.memorialId, memorialIds));
    await db()
      .delete(memorialSlugRedirects)
      .where(inArray(memorialSlugRedirects.memorialId, memorialIds));
    await db().delete(reports).where(inArray(reports.resourceId, memorialIds));
    await db()
      .delete(commemorations)
      .where(inArray(commemorations.memorialId, memorialIds));
    await db().delete(auditLogs).where(inArray(auditLogs.resourceId, memorialIds));
    await db()
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, memorialIds));
    await db().delete(memorials).where(inArray(memorials.id, memorialIds));
    await db()
      .delete(deceasedPeople)
      .where(inArray(deceasedPeople.id, owned.map((row) => row.personId)));
  }

  await db().delete(users).where(inArray(users.id, userIds));
});

afterAll(async () => {
  await db()
    .delete(users)
    .where(
      inArray(users.id, [reviewer.userId ?? "", superAdmin.userId ?? ""]),
    );
  await closeDb();
});

async function makeActor(): Promise<Actor> {
  const [row] = await db()
    .insert(users)
    .values({ displayName: `Person ${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no row");
  createdUserIds.push(row.id);
  return { userId: row.id, platformRole: "user" };
}

async function makeMemorial(
  owner?: Actor,
): Promise<{ owner: Actor; memorialId: string; slug: string }> {
  const actor = owner ?? (await makeActor());
  const result = await createMemorial(
    actor,
    {
      relationship: "child",
      relationshipStatementAccepted: true,
      primaryName: { value: `Subject ${randomUUID().slice(0, 6)}` },
    },
    randomUUID(),
    "req_setup",
  );
  if (!result.ok) throw new Error("memorial creation failed");

  await db()
    .update(memorials)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(memorials.id, result.value.memorialId));

  return { owner: actor, memorialId: result.value.memorialId, slug: result.value.slug };
}

describe("submitting a report", () => {
  it("is open to someone who is not signed in", async () => {
    // A person who finds a memorial impersonating their relative should not have
    // to register before they can say so.
    const { memorialId } = await makeMemorial();

    const result = await submitReport(
      { userId: null, platformRole: "user" },
      {
        resourceType: "memorial",
        resourceId: memorialId,
        category: "identity_impersonation",
        contactEmail: "reporter@example.test",
      },
      {},
    );

    expect(result.ok).toBe(true);
  });

  it("has no effect on the memorial by itself", async () => {
    // Doc 06 section 6 puts a reviewer between a complaint and any action, so a
    // report cannot be used to take someone's page down.
    const { memorialId } = await makeMemorial();

    await submitReport(
      { userId: null, platformRole: "user" },
      {
        resourceType: "memorial",
        resourceId: memorialId,
        category: "harassment_or_hate",
      },
      {},
    );

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(row?.status).toBe("published");
    expect(
      (await resolveAccessById(memorialId, { userId: null, platformRole: "user" }))
        .allowed,
    ).toBe(true);
  });

  it("refuses an unusable contact address", async () => {
    const { memorialId } = await makeMemorial();

    expect(
      await submitReport(
        { userId: null, platformRole: "user" },
        {
          resourceType: "memorial",
          resourceId: memorialId,
          category: "spam",
          contactEmail: "not-an-address",
        },
        {},
      ),
    ).toEqual({ ok: false, error: "INVALID_CONTACT" });
  });

  it("requires a description when the category is 'something else'", async () => {
    const { memorialId } = await makeMemorial();

    expect(
      await submitReport(
        { userId: null, platformRole: "user" },
        {
          resourceType: "memorial",
          resourceId: memorialId,
          category: "other_safety",
        },
        {},
      ),
    ).toEqual({ ok: false, error: "EMPTY_REPORT" });
  });
});

describe("reviewer actions", () => {
  it("are refused to an ordinary user", async () => {
    const { owner, memorialId } = await makeMemorial();

    expect(
      await applyRestriction(
        owner,
        { memorialId, restriction: "temporarily_hide", reason: "No." },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("record the reason, the old state and the new one", async () => {
    // The question a family asks afterwards is why, and an action with no
    // stated reason cannot be reviewed or appealed.
    const { memorialId } = await makeMemorial();

    await applyRestriction(
      reviewer,
      {
        memorialId,
        restriction: "restrict_interactions",
        reason: "Repeated abusive messages from several visitors.",
      },
      "req_restrict",
    );

    const [action] = await db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.resourceId, memorialId));

    expect(action?.action).toBe("restrict_interactions");
    expect(action?.reason).toBe(
      "Repeated abusive messages from several visitors.",
    );
    expect(action?.correlationId).toBe("req_restrict");
    expect(action?.actorUserId).toBe(reviewer.userId);
    expect(action?.oldValue).toMatchObject({ status: "published" });
  });

  it("hide a memorial from the public but not from the family", async () => {
    const { owner, memorialId } = await makeMemorial();

    await applyRestriction(
      reviewer,
      { memorialId, restriction: "temporarily_hide", reason: "Under review." },
      "r1",
    );

    expect(
      await resolveAccessById(memorialId, { userId: null, platformRole: "user" }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
    // The family can still see their relative's page while the case is open.
    expect((await resolveAccessById(memorialId, owner)).allowed).toBe(true);
  });

  it("are lifted by a restore, which is itself recorded", async () => {
    const { memorialId } = await makeMemorial();

    await applyRestriction(
      reviewer,
      { memorialId, restriction: "temporarily_hide", reason: "Under review." },
      "r1",
    );
    await restoreMemorial(
      reviewer,
      { memorialId, reason: "The complaint was not substantiated." },
      "r2",
    );

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(row?.status).toBe("published");
    expect(row?.editingRestrictedAt).toBeNull();

    const actions = await db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.resourceId, memorialId));
    expect(actions.map((a) => a.action)).toContain("restore");
  });
});

describe("case lifecycle", () => {
  it("moves through the documented states", async () => {
    const { memorialId } = await makeMemorial();
    const opened = await openCase(
      reviewer,
      { memorialId, kind: "content_review" },
      "r1",
    );
    if (!opened.ok) throw new Error("open failed");

    for (const status of ["triaged", "investigating", "resolved"] as const) {
      const result = await setCaseStatus(
        reviewer,
        { caseId: opened.value.caseId, status },
        "r2",
      );
      expect(result.ok).toBe(true);
    }

    const [row] = await db()
      .select()
      .from(moderationCases)
      .where(eq(moderationCases.id, opened.value.caseId));
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });

  it("allows one appeal and then no more", async () => {
    // Doc 06 section 7: one review, then the decision stands.
    const { memorialId } = await makeMemorial();
    const opened = await openCase(
      reviewer,
      { memorialId, kind: "content_review" },
      "r1",
    );
    if (!opened.ok) throw new Error("open failed");

    await setCaseStatus(reviewer, { caseId: opened.value.caseId, status: "resolved" }, "r2");

    expect(
      (await setCaseStatus(reviewer, { caseId: opened.value.caseId, status: "appealed" }, "r3"))
        .ok,
    ).toBe(true);
    expect(
      await setCaseStatus(reviewer, { caseId: opened.value.caseId, status: "appealed" }, "r4"),
    ).toEqual({ ok: false, error: "APPEAL_ALREADY_USED" });
  });

  it("attaches reports to the case that answers them", async () => {
    const { memorialId } = await makeMemorial();
    const report = await submitReport(
      { userId: null, platformRole: "user" },
      { resourceType: "memorial", resourceId: memorialId, category: "spam" },
      {},
    );
    if (!report.ok) throw new Error("report failed");

    const opened = await openCase(
      reviewer,
      { memorialId, kind: "spam", reportIds: [report.value.reportId] },
      "r1",
    );
    if (!opened.ok) throw new Error("open failed");

    const [row] = await db()
      .select()
      .from(reports)
      .where(eq(reports.id, report.value.reportId));
    expect(row?.caseId).toBe(opened.value.caseId);
    expect(row?.status).toBe("triaged");
  });
});

describe("ownership disputes", () => {
  it("freeze ownership and privacy, but not editing", async () => {
    // The family in place is still a grieving family. Locking their relative's
    // page over an unproven claim would punish them for being disputed.
    const { owner, memorialId } = await makeMemorial();
    const claimant = await makeActor();

    const dispute = await openOwnershipDispute(
      claimant,
      {
        memorialId,
        claimedRelationship: "spouse",
        statement: "I am his widow and was not consulted.",
      },
      "r1",
    );
    expect(dispute.ok).toBe(true);

    expect(await isOwnershipFrozen(memorialId)).toBe(true);

    // Privacy is frozen.
    expect(
      await changePrivacy(owner, memorialId, { visibility: "invite_only" }, "r2"),
    ).toEqual({ ok: false, error: "OWNERSHIP_FROZEN" });

    // Editing is not.
    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(row?.editingRestrictedAt).toBeNull();
  });

  it("do not let the platform rank one relationship above another", async () => {
    // Doc 06 section 7 and doc 11 section 3: the priority between a spouse, a
    // parent, a child and a sibling is an unmade policy decision, and encoding
    // a guess would settle it for every family on the platform.
    const { memorialId } = await makeMemorial();

    for (const relationship of ["spouse", "parent", "child", "sibling"] as const) {
      const claimant = await makeActor();
      const dispute = await openOwnershipDispute(
        claimant,
        { memorialId, claimedRelationship: relationship, statement: "A claim." },
        "r1",
      );
      expect(dispute.ok).toBe(true);
    }

    const rows = await db()
      .select()
      .from(ownershipDisputes)
      .where(eq(ownershipDisputes.memorialId, memorialId));

    // All four are recorded as open, with no ordering applied.
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("open");
      expect(row.outcome).toBeNull();
    }
  });

  it("cannot be opened by the current owner", async () => {
    const { owner, memorialId } = await makeMemorial();

    expect(
      await openOwnershipDispute(
        owner,
        { memorialId, claimedRelationship: "child", statement: "Mine." },
        "r1",
      ),
    ).toEqual({ ok: false, error: "OWNER_CANNOT_DISPUTE" });
  });

  it("cannot be opened twice by the same person", async () => {
    const { memorialId } = await makeMemorial();
    const claimant = await makeActor();

    await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "sibling", statement: "First claim." },
      "r1",
    );

    expect(
      await openOwnershipDispute(
        claimant,
        { memorialId, claimedRelationship: "sibling", statement: "Again." },
        "r2",
      ),
    ).toEqual({ ok: false, error: "ALREADY_CLAIMED" });
  });

  it("lift the freeze once decided, either way", async () => {
    const { memorialId } = await makeMemorial();
    const claimant = await makeActor();

    const dispute = await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );
    if (!dispute.ok) throw new Error("dispute failed");

    await decideDispute(
      superAdmin,
      {
        disputeId: dispute.value.disputeId,
        outcome: "rejected",
        reason: "The relationship could not be substantiated.",
      },
      "r2",
    );

    expect(await isOwnershipFrozen(memorialId)).toBe(false);
  });

  it("transfer ownership only as a recorded outcome", async () => {
    const { owner, memorialId } = await makeMemorial();
    const claimant = await makeActor();

    const dispute = await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );
    if (!dispute.ok) throw new Error("dispute failed");

    await decideDispute(
      superAdmin,
      {
        disputeId: dispute.value.disputeId,
        outcome: "upheld",
        reason: "Marriage certificate verified.",
        transferOwnershipTo: claimant.userId ?? "",
      },
      "r2",
    );

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, memorialId));
    expect(row?.ownerUserId).toBe(claimant.userId);

    const transfer = await db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.resourceId, memorialId));
    const record = transfer.find((a) => a.action === "transfer_ownership");
    expect(record?.reason).toBe("Marriage certificate verified.");
    expect(record?.oldValue).toMatchObject({ ownerUserId: owner.userId });
  });

  it("allow one appeal and then no more", async () => {
    const { memorialId } = await makeMemorial();
    const claimant = await makeActor();

    const dispute = await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "child", statement: "A claim." },
      "r1",
    );
    if (!dispute.ok) throw new Error("dispute failed");

    await decideDispute(
      superAdmin,
      { disputeId: dispute.value.disputeId, outcome: "rejected", reason: "No." },
      "r2",
    );

    expect((await appealDispute(claimant, dispute.value.disputeId, "r3")).ok).toBe(
      true,
    );
    expect(await appealDispute(claimant, dispute.value.disputeId, "r4")).toEqual({
      ok: false,
      error: "APPEAL_ALREADY_USED",
    });
  });

  it("are refused to an ordinary user trying to decide one", async () => {
    const { memorialId } = await makeMemorial();
    const claimant = await makeActor();
    const bystander = await makeActor();

    const dispute = await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );
    if (!dispute.ok) throw new Error("dispute failed");

    expect(
      await decideDispute(
        bystander,
        { disputeId: dispute.value.disputeId, outcome: "upheld", reason: "Me." },
        "r2",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("dispute evidence", () => {
  async function withEvidence(): Promise<{
    claimant: Actor;
    disputeId: string;
    evidenceId: string;
    objectKey: string;
    memorialId: string;
  }> {
    const { memorialId } = await makeMemorial();
    const claimant = await makeActor();
    const dispute = await openOwnershipDispute(
      claimant,
      { memorialId, claimedRelationship: "spouse", statement: "A claim." },
      "r1",
    );
    if (!dispute.ok) throw new Error("dispute failed");

    const attached = await attachEvidence(
      claimant,
      {
        disputeId: dispute.value.disputeId,
        contentType: "application/pdf",
        extension: "pdf",
      },
      "r2",
    );
    if (!attached.ok) throw new Error("attach failed");

    return {
      claimant,
      disputeId: dispute.value.disputeId,
      evidenceId: attached.value.evidenceId,
      objectKey: attached.value.objectKey,
      memorialId,
    };
  }

  it("is stored under a prefix that memorial media never uses", async () => {
    // Doc 06 sections 4 and 7. A death certificate must not sit alongside the
    // photographs anyone with the page can see.
    const { objectKey, memorialId } = await withEvidence();

    expect(objectKey.startsWith("dispute-evidence/")).toBe(true);
    expect(objectKey).not.toContain("memorials/");
    expect(objectKey).not.toContain(memorialId);
  });

  it("is refused to a bystander", async () => {
    const { disputeId } = await withEvidence();
    const bystander = await makeActor();

    expect(
      await attachEvidence(
        bystander,
        { disputeId, contentType: "application/pdf", extension: "pdf" },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("cannot be read by an ordinary user, including the claimant", async () => {
    // Reading is a reviewer capability. The claimant supplied the document and
    // does not need to fetch it back through the moderation path.
    const { claimant, evidenceId } = await withEvidence();

    expect(
      await accessEvidence(claimant, evidenceId, "Curious.", "r1"),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("records every read, with a reason", async () => {
    // Doc 06 section 5: someone's death certificate is not a document that
    // should be openable without a trace, even by staff.
    const { evidenceId } = await withEvidence();

    await accessEvidence(
      reviewer,
      evidenceId,
      "Verifying the claimed relationship.",
      "req_access",
    );

    const [row] = await db()
      .select()
      .from(disputeEvidence)
      .where(eq(disputeEvidence.id, evidenceId));
    expect(row?.accessCount).toBe(1);
    expect(row?.lastAccessedAt).toBeInstanceOf(Date);

    const actions = await db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.resourceId, evidenceId));

    // Attaching and reading are separate kinds. Conflating them would mean an
    // auditor could not tell a claimant uploading their own certificate from a
    // staff member opening someone else's.
    const attached = actions.filter(
      (a) => a.action === "attach_dispute_evidence",
    );
    const read = actions.filter((a) => a.action === "access_dispute_evidence");

    expect(attached).toHaveLength(1);
    expect(read).toHaveLength(1);
    expect(read[0]?.reason).toBe("Verifying the claimed relationship.");
    expect(read[0]?.actorUserId).toBe(reviewer.userId);
  });

  it("counts each read separately", async () => {
    const { evidenceId } = await withEvidence();

    await accessEvidence(reviewer, evidenceId, "First look.", "r1");
    await accessEvidence(reviewer, evidenceId, "Second look.", "r2");

    const [row] = await db()
      .select()
      .from(disputeEvidence)
      .where(eq(disputeEvidence.id, evidenceId));
    expect(row?.accessCount).toBe(2);
  });

  it("never appears in a memorial's own records", async () => {
    const { memorialId, objectKey } = await withEvidence();

    // Nothing that describes the memorial mentions the evidence object.
    const names = await db()
      .select()
      .from(memorialNames)
      .where(eq(memorialNames.memorialId, memorialId));
    const audit = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, memorialId));

    expect(JSON.stringify(names)).not.toContain(objectKey);
    expect(JSON.stringify(audit)).not.toContain(objectKey);
  });
});

describe("merging duplicates", () => {
  it("is refused to an ordinary user", async () => {
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    expect(
      await mergeDuplicateMemorials(
        primary.owner,
        {
          primaryMemorialId: primary.memorialId,
          mergedMemorialId: secondary.memorialId,
          reason: "Same person.",
        },
        "r1",
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("requires a reason", async () => {
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    expect(
      await mergeDuplicateMemorials(
        reviewer,
        {
          primaryMemorialId: primary.memorialId,
          mergedMemorialId: secondary.memorialId,
          reason: "   ",
        },
        "r1",
      ),
    ).toEqual({ ok: false, error: "EMPTY_REASON" });
  });

  it("keeps the old address working", async () => {
    // A link a family sent to relatives years ago must not start returning
    // nothing because a reviewer tidied up.
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    const merged = await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "The same person, recorded twice.",
      },
      "r1",
    );
    expect(merged.ok).toBe(true);

    expect(await resolveSlugRedirect(secondary.slug)).toBe(primary.memorialId);
  });

  it("leaves the merged memorial recognizable rather than deleting it", async () => {
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "Duplicate.",
      },
      "r1",
    );

    const [row] = await db()
      .select()
      .from(memorials)
      .where(eq(memorials.id, secondary.memorialId));
    expect(row?.status).toBe("merged");
    expect(row?.mergedIntoMemorialId).toBe(primary.memorialId);

    // Visiting it directly is a redirect, not a 404 and not a private page.
    expect(
      await resolveAccessById(secondary.memorialId, {
        userId: null,
        platformRole: "user",
      }),
    ).toEqual({ allowed: false, reason: "MERGED" });
  });

  it("preserves who wrote what", async () => {
    // Rewriting authorship to the surviving owner would quietly reassign what
    // people wrote about someone who died.
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    await db().insert(memorialNames).values({
      memorialId: secondary.memorialId,
      value: "A name recorded on the other page",
      type: "alias",
      searchable: false,
    });

    await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "Duplicate.",
      },
      "r1",
    );

    const names = await db()
      .select()
      .from(memorialNames)
      .where(eq(memorialNames.memorialId, primary.memorialId));

    const moved = names.find(
      (n) => n.value === "A name recorded on the other page",
    );
    expect(moved).toBeDefined();
    // A name the family kept unsearchable stays unsearchable after a merge.
    expect(moved?.searchable).toBe(false);
  });

  it("keeps the other page's family as administrators", async () => {
    // A memorial has one owner, and demoting the other family to nothing would
    // remove people who had been managing their relative's page.
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "Duplicate.",
      },
      "r1",
    );

    const members = await db()
      .select()
      .from(memorialMembers)
      .where(eq(memorialMembers.memorialId, primary.memorialId));

    const carried = members.find((m) => m.userId === secondary.owner.userId);
    expect(carried?.role).toBe("admin");
  });

  it("records the merge with a reason", async () => {
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "Confirmed by the family of both pages.",
      },
      "req_merge",
    );

    const [action] = await db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.resourceId, secondary.memorialId));

    expect(action?.action).toBe("merge_duplicate");
    expect(action?.reason).toBe("Confirmed by the family of both pages.");
    expect(action?.oldValue).toMatchObject({ slug: secondary.slug });
    expect(action?.newValue).toMatchObject({ mergedInto: primary.memorialId });
  });

  it("cannot be done twice", async () => {
    const primary = await makeMemorial();
    const secondary = await makeMemorial();

    await mergeDuplicateMemorials(
      reviewer,
      {
        primaryMemorialId: primary.memorialId,
        mergedMemorialId: secondary.memorialId,
        reason: "Duplicate.",
      },
      "r1",
    );

    expect(
      await mergeDuplicateMemorials(
        reviewer,
        {
          primaryMemorialId: primary.memorialId,
          mergedMemorialId: secondary.memorialId,
          reason: "Again.",
        },
        "r2",
      ),
    ).toEqual({ ok: false, error: "ALREADY_MERGED" });
  });

  it("refuses to merge a memorial into itself", async () => {
    const primary = await makeMemorial();

    expect(
      await mergeDuplicateMemorials(
        reviewer,
        {
          primaryMemorialId: primary.memorialId,
          mergedMemorialId: primary.memorialId,
          reason: "Oops.",
        },
        "r1",
      ),
    ).toEqual({ ok: false, error: "SAME_MEMORIAL" });
  });
});
