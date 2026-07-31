import type {
  Actor,
  GovernanceAction,
  MemorialAction,
  MemorialRole,
} from "./types";

/**
 * The single place authorization is decided.
 *
 * Every protected read and write calls one of these two functions. Scattering
 * role checks through route handlers is how a permission ends up enforced in
 * four places and forgotten in a fifth.
 *
 * Both are pure: no database, no session lookup. The caller resolves who the
 * actor is and what role they hold, then asks.
 */

/**
 * Allow lists, transcribed from doc 06 section 3.
 *
 * Deliberately not deny lists. A new action added to `MemorialAction` is
 * refused for every role until someone deliberately grants it, rather than
 * being permitted by nobody having thought about it.
 */
const MEMORIAL_PERMISSIONS: Record<MemorialRole, readonly MemorialAction[]> = {
  owner: [
    "edit_profile",
    "change_privacy",
    "manage_members",
    "transfer_ownership",
    "publish_content",
    "moderate_submission",
    "configure_rituals",
    "request_export",
    "request_deletion",
    "manage_family_links",
  ],
  // An administrator helps run the memorial but cannot decide who may see it,
  // hand it to someone else, or delete it.
  admin: [
    "edit_profile",
    "manage_members",
    "publish_content",
    "moderate_submission",
    "request_export",
    // A confirmed family link does not change who may see this memorial —
    // traversal still asks the privacy rules for every node. It is a statement
    // about who the person was, which is the kind of thing an administrator
    // helping run the memorial is already trusted with.
    "manage_family_links",
  ],
  editor: ["edit_profile", "publish_content"],
  // A reviewer only screens what visitors submit.
  reviewer: ["moderate_submission"],
  // An invited visitor may see the memorial; membership grants no editing.
  invited_visitor: [],
};

const GOVERNANCE_PERMISSIONS: Record<
  "reviewer" | "super_admin",
  readonly GovernanceAction[]
> = {
  reviewer: [
    "restrict_editing",
    "restrict_interactions",
    "temporarily_hide",
    "restore",
    "merge_duplicate",
    "resolve_dispute",
    "access_dispute_evidence",
  ],
  super_admin: [
    "restrict_editing",
    "restrict_interactions",
    "temporarily_hide",
    "restore",
    "merge_duplicate",
    "resolve_dispute",
    "access_dispute_evidence",
    // A published ritual version becomes a statement about someone's faith, and
    // a feature switch changes the platform for everyone. Both sit above the
    // day-to-day moderation bar.
    "publish_ritual_version",
    "change_feature_flag",
  ],
};

/**
 * Whether an actor may perform a family action on one memorial.
 *
 * Platform staff get nothing here. Their powers are governance actions, and
 * being a reviewer never adds to what someone can do as a family member.
 */
export function canOnMemorial(input: {
  actor: Actor;
  role: MemorialRole | null;
  action: MemorialAction;
}): boolean {
  // A role only means something attached to an account.
  if (!input.actor.userId || !input.role) {
    return false;
  }

  return MEMORIAL_PERMISSIONS[input.role].includes(input.action);
}

export function canGovern(input: {
  actor: Actor;
  action: GovernanceAction;
}): boolean {
  if (!input.actor.userId) {
    return false;
  }

  if (input.actor.platformRole === "user") {
    return false;
  }

  return GOVERNANCE_PERMISSIONS[input.actor.platformRole].includes(input.action);
}
