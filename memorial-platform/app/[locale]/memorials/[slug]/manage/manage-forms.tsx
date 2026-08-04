"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

export type ManageableRitual = {
  ritualVersionId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  allowAnonymous: boolean;
  allowMessage: boolean;
  moderationMode: "pre_review" | "post_review";
};

type Notice =
  | { kind: "none" }
  | { kind: "saved" }
  | { kind: "published" }
  | { kind: "error"; code: string };

export function ManageForms(props: {
  memorialId: string;
  locale: string;
  slug: string;
  mayEditStory: boolean;
  mayConfigure: boolean;
  initialTitle: string;
  initialBody: string;
  hasUnpublishedDraft: boolean;
  rituals: ManageableRitual[];
}) {
  const t = useTranslations("memorial");
  const ritual = useTranslations("ritual");
  const errors = useTranslations("errors");
  const common = useTranslations("common");
  const router = useRouter();

  const [title, setTitle] = useState(props.initialTitle);
  const [body, setBody] = useState(props.initialBody);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  // Tracks whether a draft exists that visitors are not seeing, so the publish
  // button is not offered for words already on the page.
  const [draftPending, setDraftPending] = useState(props.hasUnpublishedDraft);

  const [rituals, setRituals] = useState(props.rituals);
  const [busyRitual, setBusyRitual] = useState<string | null>(null);

  function readError(payload: unknown): string {
    const error = (payload as { error?: { code?: string } })?.error;
    return error?.code ?? "unexpected";
  }

  async function saveDraft(): Promise<void> {
    setSaving(true);
    setNotice({ kind: "none" });

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/biography`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(title.trim() ? { title: title.trim() } : {}),
            body,
            sourceLocale: props.locale,
          }),
        },
      );

      if (!response.ok) {
        setNotice({
          kind: "error",
          code: readError(await response.json().catch(() => null)),
        });
        return;
      }

      setDraftPending(true);
      setNotice({ kind: "saved" });
    } catch {
      setNotice({ kind: "error", code: "DEPENDENCY_UNAVAILABLE" });
    } finally {
      setSaving(false);
    }
  }

  async function publishStory(): Promise<void> {
    setSaving(true);
    setNotice({ kind: "none" });

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/biography/publish`,
        { method: "POST" },
      );

      if (!response.ok) {
        setNotice({
          kind: "error",
          code: readError(await response.json().catch(() => null)),
        });
        return;
      }

      setDraftPending(false);
      setNotice({ kind: "published" });
      // The memorial page renders the published version, so it is now stale.
      router.refresh();
    } catch {
      setNotice({ kind: "error", code: "DEPENDENCY_UNAVAILABLE" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleRitual(target: ManageableRitual): Promise<void> {
    setBusyRitual(target.ritualVersionId);
    setNotice({ kind: "none" });

    const nextEnabled = !target.enabled;

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/ritual-settings/${target.ritualVersionId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: nextEnabled,
            // Sent only when switching on. The server refuses to enable
            // anything without it, and turning something off needs no
            // confirmation — a family withdrawing an offer is always allowed.
            ...(nextEnabled ? { familyConfirmed: true } : {}),
            allowAnonymous: target.allowAnonymous,
            allowMessage: target.allowMessage,
            moderationMode: target.moderationMode,
          }),
        },
      );

      if (!response.ok) {
        setNotice({
          kind: "error",
          code: readError(await response.json().catch(() => null)),
        });
        return;
      }

      setRituals((current) =>
        current.map((item) =>
          item.ritualVersionId === target.ritualVersionId
            ? { ...item, enabled: nextEnabled }
            : item,
        ),
      );
      router.refresh();
    } catch {
      setNotice({ kind: "error", code: "DEPENDENCY_UNAVAILABLE" });
    } finally {
      setBusyRitual(null);
    }
  }

  return (
    <div className="stack-lg">
      {notice.kind === "saved" ? (
        <p className="notice">{t("lifeStorySaved")}</p>
      ) : null}
      {notice.kind === "published" ? (
        <p className="notice">{t("lifeStoryPublished")}</p>
      ) : null}
      {notice.kind === "error" ? (
        <p className="fieldError" role="alert">
          {errors.has(notice.code) ? errors(notice.code) : errors("unexpected")}
        </p>
      ) : null}

      {props.mayEditStory ? (
        <section className="stack measure">
          <h2>{t("lifeStory")}</h2>

          <label className="field">
            <span className="fieldLabel">{t("lifeStoryTitleLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">{t("lifeStoryBodyLabel")}</span>
            <textarea
              className="input"
              rows={14}
              maxLength={50_000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>

          <div className="ritualChoices">
            <button
              type="button"
              className="button buttonQuiet"
              disabled={saving || body.trim().length === 0}
              onClick={saveDraft}
            >
              {saving ? common("loading") : t("saveDraft")}
            </button>

            {draftPending ? (
              <button
                type="button"
                className="button buttonPrimary"
                disabled={saving}
                onClick={publishStory}
              >
                {t("publishStory")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {props.mayConfigure ? (
        <section className="stack measure">
          <h2>{t("ritualsHeading")}</h2>
          <p className="muted">{ritual("help")}</p>

          {rituals.length === 0 ? (
            <p className="muted">{t("ritualsNone")}</p>
          ) : (
            <ul className="resultList">
              {rituals.map((item) => (
                <li className="resultItem stack" key={item.ritualVersionId}>
                  <strong>{item.name}</strong>
                  {item.description ? (
                    <p className="muted">{item.description}</p>
                  ) : null}
                  {item.enabled && item.moderationMode === "pre_review" ? (
                    <p className="muted">{ritual("moderationPre")}</p>
                  ) : null}
                  <div>
                    <button
                      type="button"
                      className={
                        item.enabled
                          ? "button buttonQuiet"
                          : "button buttonPrimary"
                      }
                      aria-pressed={item.enabled}
                      disabled={busyRitual === item.ritualVersionId}
                      onClick={() => toggleRitual(item)}
                    >
                      {busyRitual === item.ritualVersionId
                        ? common("loading")
                        : item.enabled
                          ? ritual("disable")
                          : ritual("enable")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div>
        <Link
          className="button buttonQuiet"
          href={`/${props.locale}/memorials/${props.slug}`}
        >
          {common("back")}
        </Link>
      </div>
    </div>
  );
}
