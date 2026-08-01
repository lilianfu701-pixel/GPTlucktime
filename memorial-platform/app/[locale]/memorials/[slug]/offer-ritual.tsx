"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

export type OfferableRitual = {
  ritualVersionId: string;
  name: string | null;
  allowAnonymous: boolean;
  allowMessage: boolean;
  moderationMode: "pre_review" | "post_review";
};

type Outcome =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "published" }
  | { kind: "pending" }
  | { kind: "error"; code: string };

/**
 * Offering a flower, a candle, or a prayer.
 *
 * The idempotency key is minted once per attempt and reused when the same
 * attempt is retried. A visitor whose connection dropped mid-request taps the
 * button again and leaves one flower, not two — the server recognizes the key
 * and replays its first answer.
 */
export function OfferRitual(props: {
  memorialId: string;
  locale: string;
  rituals: OfferableRitual[];
}) {
  const t = useTranslations("ritual");
  const moderation = useTranslations("moderation");
  const errors = useTranslations("errors");
  const common = useTranslations("common");

  const [selected, setSelected] = useState<OfferableRitual | null>(null);
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  function choose(ritual: OfferableRitual): void {
    setSelected(ritual);
    setMessage("");
    setOutcome({ kind: "idle" });
    // A new intention is a new key. Reusing the previous one would make a
    // second, genuinely different offering look like a retry of the first.
    setAttemptKey(crypto.randomUUID());
  }

  async function submit(): Promise<void> {
    if (!selected) {
      return;
    }

    setOutcome({ kind: "sending" });

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/commemorations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": attemptKey,
          },
          body: JSON.stringify({
            ritualVersionId: selected.ritualVersionId,
            locale: props.locale,
            ...(message.trim().length > 0 ? { message: message.trim() } : {}),
          }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setOutcome({
          kind: "error",
          code: body?.error?.code ?? "unexpected",
        });
        return;
      }

      // 202 means the family reads it first. Showing this as published would
      // tell a mourner their words are on the page when they are not.
      setOutcome({ kind: response.status === 202 ? "pending" : "published" });
    } catch {
      setOutcome({ kind: "error", code: "DEPENDENCY_UNAVAILABLE" });
    }
  }

  if (outcome.kind === "pending") {
    return (
      <div className="notice noticePending stack">
        <strong>{moderation("pendingTitle")}</strong>
        <p>{moderation("pendingBody")}</p>
      </div>
    );
  }

  if (outcome.kind === "published") {
    return (
      <div className="notice stack">
        <p>{t("thanks")}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="ritualChoices">
        {props.rituals.map((ritual) => (
          <button
            type="button"
            key={ritual.ritualVersionId}
            className={
              selected?.ritualVersionId === ritual.ritualVersionId
                ? "button buttonPrimary"
                : "button buttonQuiet"
            }
            aria-pressed={selected?.ritualVersionId === ritual.ritualVersionId}
            onClick={() => choose(ritual)}
          >
            {ritual.name ?? t("offerFallback")}
          </button>
        ))}
      </div>

      {selected ? (
        <div className="stack">
          {selected.allowMessage ? (
            <label className="field">
              <span className="fieldLabel">{t("messageLabel")}</span>
              <textarea
                className="input"
                rows={4}
                maxLength={2000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
          ) : null}

          {/*
           * Said before the button, not after the answer. Someone writing to
           * their mother deserves to know the family will read it first while
           * they are still choosing their words.
           */}
          {selected.moderationMode === "pre_review" ? (
            <p className="muted">{t("moderationPre")}</p>
          ) : null}

          <div>
            <button
              type="button"
              className="button buttonPrimary"
              disabled={outcome.kind === "sending"}
              onClick={submit}
            >
              {outcome.kind === "sending"
                ? common("loading")
                : common("continue")}
            </button>
          </div>

          {outcome.kind === "error" ? (
            <p className="fieldError" role="alert">
              {errors.has(outcome.code)
                ? errors(outcome.code)
                : errors("unexpected")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
