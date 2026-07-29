import { describe, expect, it } from "vitest";
import { canGovern, canOnMemorial } from "@/modules/permissions/policy";
import type {
  Actor,
  GovernanceAction,
  MemorialAction,
  MemorialRole,
} from "@/modules/permissions/types";

const user: Actor = { userId: "u1", platformRole: "user" };
const platformReviewer: Actor = { userId: "staff", platformRole: "reviewer" };
const superAdmin: Actor = { userId: "admin", platformRole: "super_admin" };
const anonymous: Actor = { userId: null, platformRole: "user" };

type Row = {
  role: MemorialRole | null;
  allowed: MemorialAction[];
};

/**
 * The table published in doc 06 section 3, transcribed action by action.
 *
 * Anything not listed for a role is denied. Writing it as an allow list rather
 * than a deny list means a new action is refused until someone decides it is
 * safe, instead of being granted by omission.
 */
const MATRIX: Row[] = [
  {
    role: "owner",
    allowed: [
      "edit_profile",
      "change_privacy",
      "manage_members",
      "transfer_ownership",
      "publish_content",
      "moderate_submission",
      "configure_rituals",
      "request_export",
      "request_deletion",
    ],
  },
  {
    role: "admin",
    allowed: [
      "edit_profile",
      "manage_members",
      "publish_content",
      "moderate_submission",
      "request_export",
    ],
  },
  { role: "editor", allowed: ["edit_profile", "publish_content"] },
  { role: "reviewer", allowed: ["moderate_submission"] },
  { role: "invited_visitor", allowed: [] },
  { role: null, allowed: [] },
];

const ALL_ACTIONS: MemorialAction[] = [
  "edit_profile",
  "change_privacy",
  "manage_members",
  "transfer_ownership",
  "publish_content",
  "moderate_submission",
  "configure_rituals",
  "request_export",
  "request_deletion",
];

describe("memorial permission matrix", () => {
  for (const row of MATRIX) {
    for (const action of ALL_ACTIONS) {
      const expected = row.allowed.includes(action);
      const label = row.role ?? "no membership";

      it(`${label} ${expected ? "may" : "may not"} ${action}`, () => {
        expect(canOnMemorial({ actor: user, role: row.role, action })).toBe(
          expected,
        );
      });
    }
  }
});

describe("owner-only actions", () => {
  // These four decide who can see the memorial, who else can manage it, and
  // whether it continues to exist. An administrator inherits none of them.
  const ownerOnly: MemorialAction[] = [
    "change_privacy",
    "transfer_ownership",
    "configure_rituals",
    "request_deletion",
  ];

  for (const action of ownerOnly) {
    it(`only the owner may ${action}`, () => {
      expect(canOnMemorial({ actor: user, role: "owner", action })).toBe(true);
      for (const role of ["admin", "editor", "reviewer", "invited_visitor"] as const) {
        expect(canOnMemorial({ actor: user, role, action })).toBe(false);
      }
    });
  }
});

describe("platform staff separation", () => {
  it("gives a platform reviewer no editorial power over a memorial", () => {
    // Doc 06 section 3: staff carry out defined governance actions and do not
    // rewrite a family's account of a life.
    for (const action of ALL_ACTIONS) {
      expect(
        canOnMemorial({ actor: platformReviewer, role: null, action }),
      ).toBe(false);
    }
  });

  it("gives a super admin no editorial power either", () => {
    for (const action of ALL_ACTIONS) {
      expect(canOnMemorial({ actor: superAdmin, role: null, action })).toBe(
        false,
      );
    }
  });

  it("does not let staff status upgrade a family role", () => {
    // A staff member who is also an editor on their own relative's memorial is
    // an editor there, and nothing more.
    expect(
      canOnMemorial({
        actor: platformReviewer,
        role: "editor",
        action: "change_privacy",
      }),
    ).toBe(false);
    expect(
      canOnMemorial({
        actor: platformReviewer,
        role: "editor",
        action: "edit_profile",
      }),
    ).toBe(true);
  });

  it("refuses everything to an anonymous caller", () => {
    for (const action of ALL_ACTIONS) {
      expect(canOnMemorial({ actor: anonymous, role: null, action })).toBe(false);
    }
  });

  it("refuses a membership role presented without a signed-in user", () => {
    // A role only means something attached to an account. Trusting a role with
    // no user would let an unauthenticated request claim ownership.
    for (const action of ALL_ACTIONS) {
      expect(canOnMemorial({ actor: anonymous, role: "owner", action })).toBe(
        false,
      );
    }
  });
});

describe("governance actions", () => {
  const reviewerActions: GovernanceAction[] = [
    "restrict_editing",
    "restrict_interactions",
    "temporarily_hide",
    "restore",
    "merge_duplicate",
    "resolve_dispute",
    "access_dispute_evidence",
  ];

  for (const action of reviewerActions) {
    it(`a platform reviewer may ${action}`, () => {
      expect(canGovern({ actor: platformReviewer, action })).toBe(true);
    });
  }

  it("refuses governance to an ordinary user, whatever their family role", () => {
    for (const action of reviewerActions) {
      expect(canGovern({ actor: user, action })).toBe(false);
    }
  });

  it("reserves publishing a ritual version for a super admin", () => {
    // A published ritual version becomes a claim about someone's religion. It
    // needs the higher bar even among staff.
    expect(
      canGovern({ actor: platformReviewer, action: "publish_ritual_version" }),
    ).toBe(false);
    expect(canGovern({ actor: superAdmin, action: "publish_ritual_version" })).toBe(
      true,
    );
  });

  it("reserves feature switches for a super admin", () => {
    expect(canGovern({ actor: platformReviewer, action: "change_feature_flag" })).toBe(
      false,
    );
    expect(canGovern({ actor: superAdmin, action: "change_feature_flag" })).toBe(
      true,
    );
  });

  it("refuses governance to an anonymous caller", () => {
    for (const action of reviewerActions) {
      expect(canGovern({ actor: anonymous, action })).toBe(false);
    }
  });

  it("refuses staff powers to a staff account with no user id", () => {
    expect(
      canGovern({
        actor: { userId: null, platformRole: "super_admin" },
        action: "temporarily_hide",
      }),
    ).toBe(false);
  });
});
