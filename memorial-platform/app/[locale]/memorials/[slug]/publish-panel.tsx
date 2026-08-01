"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The step where a family says the page is ready.
 *
 * Only rendered for the owner of a draft. It is the one thing on the page that
 * changes who else in the world can read it, so the exposure warning is here
 * rather than buried in a settings screen.
 */
export function PublishPanel(props: {
  memorialId: string;
  /** Whether publishing will also make it findable by a search engine. */
  willBeIndexed: boolean;
}) {
  const t = useTranslations("memorial");
  const privacy = useTranslations("privacy");
  const errors = useTranslations("errors");
  const common = useTranslations("common");
  const router = useRouter();

  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function publish(): Promise<void> {
    setSending(true);
    setFailure(null);

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmPublicExposure: acknowledged }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(
          body?.error?.fieldErrors?._?.[0] ??
            body?.error?.fieldErrors?.confirmPublicExposure?.[0] ??
            body?.error?.code ??
            "unexpected",
        );
        return;
      }

      // The page it renders is now a different page — published, and readable
      // by whoever the family allowed — so it is re-fetched rather than patched.
      router.refresh();
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="notice noticePending stack">
      <strong>{t("draftNoticeTitle")}</strong>
      <p>{t("draftNoticeBody")}</p>

      {props.willBeIndexed ? (
        <label className="choiceRow">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{privacy("confirmPublicAcknowledge")}</span>
        </label>
      ) : null}

      <div>
        <button
          type="button"
          className="button buttonPrimary"
          disabled={sending || (props.willBeIndexed && !acknowledged)}
          onClick={publish}
        >
          {sending ? common("loading") : t("publish")}
        </button>
      </div>

      {failure ? (
        <p className="fieldError" role="alert">
          {errors.has(failure) ? errors(failure) : failure}
        </p>
      ) : null}
    </div>
  );
}
