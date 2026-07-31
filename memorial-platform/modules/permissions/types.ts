/**
 * Who is asking, and what they may do.
 *
 * Two axes are kept apart on purpose. `platformRole` is a staff capability;
 * `MemorialRole` is a family capability on one memorial. A platform reviewer
 * has governance powers over every memorial and editorial powers over none.
 *
 * See docs/memorial-platform/06-security-privacy-moderation.md section 3.
 */
export type PlatformRole = "user" | "reviewer" | "super_admin";

export type Actor = {
  userId: string | null;
  platformRole: PlatformRole;
};

export type MemorialRole =
  | "owner"
  | "admin"
  | "editor"
  | "reviewer"
  | "invited_visitor";

/** Actions a family member performs on their own memorial. */
export type MemorialAction =
  | "edit_profile"
  | "change_privacy"
  | "manage_members"
  | "transfer_ownership"
  | "publish_content"
  | "moderate_submission"
  | "configure_rituals"
  | "request_export"
  | "request_deletion"
  /** Attach this memorial's subject to a family tree, or confirm such a link. */
  | "manage_family_links";

/** Actions platform staff perform through the governance process. */
export type GovernanceAction =
  | "restrict_editing"
  | "restrict_interactions"
  | "temporarily_hide"
  | "restore"
  | "merge_duplicate"
  | "resolve_dispute"
  | "access_dispute_evidence"
  | "publish_ritual_version"
  | "change_feature_flag";

export const ANONYMOUS_ACTOR: Actor = { userId: null, platformRole: "user" };
