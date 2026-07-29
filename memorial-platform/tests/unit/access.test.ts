import { describe, expect, it } from "vitest";
import { decideAccess } from "@/modules/memorials/access";
import type { MemorialAccessFacts } from "@/modules/memorials/access";
import type { Actor, MemorialRole } from "@/modules/permissions/types";

const anonymous: Actor = { userId: null, platformRole: "user" };
const strangerSignedIn: Actor = { userId: "stranger", platformRole: "user" };
const familyMember: Actor = { userId: "relative", platformRole: "user" };
const platformReviewer: Actor = { userId: "staff", platformRole: "reviewer" };

const published = (
  visibility: MemorialAccessFacts["visibility"],
): MemorialAccessFacts => ({ visibility, status: "published" });

const MEMBER_ROLES: MemorialRole[] = [
  "owner",
  "admin",
  "editor",
  "reviewer",
  "invited_visitor",
];

describe("public memorials", () => {
  it("lets anyone in", () => {
    expect(
      decideAccess({ memorial: published("public"), role: null, actor: anonymous }),
    ).toEqual({ allowed: true, role: "public_visitor" });
  });

  it("lets a signed-in stranger in as a visitor", () => {
    expect(
      decideAccess({
        memorial: published("public"),
        role: null,
        actor: strangerSignedIn,
      }),
    ).toEqual({ allowed: true, role: "public_visitor" });
  });

  it("reports the family role for a member", () => {
    for (const role of MEMBER_ROLES) {
      expect(
        decideAccess({ memorial: published("public"), role, actor: familyMember }),
      ).toEqual({ allowed: true, role });
    }
  });
});

describe("unlisted memorials", () => {
  it("lets a visitor holding the address in", () => {
    // Holding the link is the only credential asked for. It is kept out of
    // search rather than placed behind a sign-in.
    expect(
      decideAccess({
        memorial: published("unlisted"),
        role: null,
        actor: anonymous,
      }),
    ).toEqual({ allowed: true, role: "public_visitor" });
  });
});

describe("invite-only memorials", () => {
  it("tells an anonymous visitor it does not exist", () => {
    // Not FORBIDDEN. A 403 would confirm that a memorial for a named person is
    // on this platform, which is the fact the family chose to withhold.
    expect(
      decideAccess({
        memorial: published("invite_only"),
        role: null,
        actor: anonymous,
      }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
  });

  it("tells a signed-in stranger it does not exist", () => {
    expect(
      decideAccess({
        memorial: published("invite_only"),
        role: null,
        actor: strangerSignedIn,
      }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
  });

  it("never answers FORBIDDEN, which would confirm existence", () => {
    const decision = decideAccess({
      memorial: published("invite_only"),
      role: null,
      actor: strangerSignedIn,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).not.toBe("FORBIDDEN");
    expect(decision.reason).not.toBe("INVITATION_REQUIRED");
  });

  it("lets an invited visitor in", () => {
    expect(
      decideAccess({
        memorial: published("invite_only"),
        role: "invited_visitor",
        actor: familyMember,
      }),
    ).toEqual({ allowed: true, role: "invited_visitor" });
  });

  it("gives platform staff no way in without a membership", () => {
    // Staff powers are governance actions, not a master key to private family
    // pages. Reading one is a separate, audited action.
    expect(
      decideAccess({
        memorial: published("invite_only"),
        role: null,
        actor: platformReviewer,
      }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
  });
});

describe("a role without a signed-in user", () => {
  it("grants nothing", () => {
    // A role only means something attached to an account. Honouring one without
    // a user would let an unauthenticated request claim membership.
    for (const visibility of ["public", "unlisted", "invite_only"] as const) {
      const decision = decideAccess({
        memorial: published(visibility),
        role: "owner",
        actor: anonymous,
      });

      if (visibility === "invite_only") {
        expect(decision).toEqual({ allowed: false, reason: "NOT_FOUND" });
      } else {
        expect(decision).toEqual({ allowed: true, role: "public_visitor" });
      }
    }
  });
});

describe("drafts", () => {
  it("are invisible to the public even when marked public", () => {
    // Visibility is what the family intends once it is published; status is
    // whether it is published at all.
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "draft" },
        role: null,
        actor: anonymous,
      }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
  });

  it("are visible to the family", () => {
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "draft" },
        role: "owner",
        actor: familyMember,
      }),
    ).toEqual({ allowed: true, role: "owner" });
  });
});

describe("memorials hidden by a moderator", () => {
  it("disappear from public view", () => {
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "hidden" },
        role: null,
        actor: anonymous,
      }),
    ).toEqual({ allowed: false, reason: "NOT_FOUND" });
  });

  it("stay visible to the family while the case is open", () => {
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "hidden" },
        role: "owner",
        actor: familyMember,
      }),
    ).toEqual({ allowed: true, role: "owner" });
  });
});

describe("memorials awaiting deletion", () => {
  it("answer GONE to a visitor when they were public", () => {
    // A returning visitor and a search engine both deserve to learn that a page
    // they knew about has been removed.
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "pending_deletion" },
        role: null,
        actor: anonymous,
      }),
    ).toEqual({ allowed: false, reason: "GONE" });
  });

  it("answer NOT_FOUND when they were never public", () => {
    // Saying "gone" about a private memorial confirms it once existed.
    for (const visibility of ["unlisted", "invite_only"] as const) {
      expect(
        decideAccess({
          memorial: { visibility, status: "pending_deletion" },
          role: null,
          actor: anonymous,
        }),
      ).toEqual({ allowed: false, reason: "NOT_FOUND" });
    }
  });

  it("remain reachable by the family during the recovery window", () => {
    // Deletion is reversible for a period, which is worthless if the owner
    // cannot open the page to undo it.
    expect(
      decideAccess({
        memorial: { visibility: "public", status: "pending_deletion" },
        role: "owner",
        actor: familyMember,
      }),
    ).toEqual({ allowed: true, role: "owner" });
  });
});

describe("a memorial that is not there", () => {
  it("is NOT_FOUND for everyone", () => {
    for (const actor of [anonymous, strangerSignedIn, platformReviewer]) {
      expect(decideAccess({ memorial: null, role: null, actor })).toEqual({
        allowed: false,
        reason: "NOT_FOUND",
      });
    }
  });

  it("is indistinguishable from an invite-only memorial", () => {
    // The whole point: a probe cannot tell an absent memorial from one it is
    // not allowed to see.
    const missing = decideAccess({
      memorial: null,
      role: null,
      actor: strangerSignedIn,
    });
    const hidden = decideAccess({
      memorial: published("invite_only"),
      role: null,
      actor: strangerSignedIn,
    });

    expect(missing).toEqual(hidden);
  });
});
