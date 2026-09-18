"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const RELATIONSHIPS = ["spouse", "parent", "child", "sibling"] as const;

const RELATION_LABEL: Record<string, string> = {
  spouse: "relationshipSpouse",
  parent: "relationshipParent",
  child: "relationshipChild",
  sibling: "relationshipSibling",
};

/**
 * A prominent banner on a platform-stewarded page (created from an obituary,
 * awaiting a family claim). It explains why the page exists and gives the
 * deceased's relatives a way to claim it. A claim is a takeover request against
 * the platform-admin owner: the admin approves it and ownership transfers,
 * clearing the stewardship. Reuses the takeover API so there is one claim path.
 */
export function ClaimBanner(props: {
  memorialId: string;
  signedIn: boolean;
  signInHref: string;
  /** Built by the site from public data, rather than from an obituary — the
   * notice explains that distinct origin. */
  imported?: boolean;
  /** The viewer's existing request against this page, if any. */
  requestStatus: "pending" | "escalated" | "declined" | null;
}) {
  const t = useTranslations("memorial");
  const common = useTranslations("common");
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [relationship, setRelationship] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    if (!relationship) {
      setError(t("takeoverNeedsRelationship"));
      return;
    }
    if (reason.trim().length === 0) {
      setError(t("takeoverNeedsReason"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/memorials/${props.memorialId}/takeover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationship,
          reason: reason.trim(),
          kind: "takeover",
        }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(t("takeoverSubmitFailed"));
    } catch {
      setError(t("takeoverSubmitFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="claimBanner">
      <p className="claimBannerTitle">
        {t(props.imported ? "importedStewardTitle" : "stewardClaimTitle")}
      </p>
      <p className="claimBannerBody">
        {t(props.imported ? "importedStewardBody" : "stewardClaimBody")}
      </p>

      {props.requestStatus ? (
        <p className="claimBannerStatus">
          {props.requestStatus === "declined"
            ? t("takeoverStatusDeclined")
            : props.requestStatus === "escalated"
              ? t("takeoverStatusEscalated")
              : t("takeoverPending")}
        </p>
      ) : !props.signedIn ? (
        <p className="claimBannerAction">
          <Link className="claimBannerLink" href={props.signInHref}>
            {t("stewardClaimSignIn")}
          </Link>
        </p>
      ) : !open ? (
        <p className="claimBannerAction">
          <button
            type="button"
            className="claimBannerLink"
            onClick={() => setOpen(true)}
          >
            {t("stewardClaimCta")}
          </button>
        </p>
      ) : (
        <div className="claimBannerForm stack">
          <label className="field">
            <span className="fieldLabel">{t("relationshipLabel")}</span>
            <select
              className="input"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
            >
              <option value="">—</option>
              {RELATIONSHIPS.map((r) => (
                <option value={r} key={r}>
                  {t(RELATION_LABEL[r]!)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="fieldLabel">{t("takeoverReasonLabel")}</span>
            <textarea
              className="input"
              rows={3}
              maxLength={2000}
              placeholder={t("takeoverReasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error ? (
            <p className="fieldError" role="alert">
              {error}
            </p>
          ) : null}
          <div className="adminHeadRow">
            <button
              type="button"
              className="button buttonPrimary buttonCompact"
              disabled={busy}
              onClick={submit}
            >
              {busy ? common("loading") : t("takeoverSubmit")}
            </button>
            <button
              type="button"
              className="button buttonQuiet buttonCompact"
              onClick={() => setOpen(false)}
            >
              {common("cancel")}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
