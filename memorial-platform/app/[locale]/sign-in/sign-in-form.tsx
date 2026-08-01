"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type Channel = "email" | "phone";

type Stage =
  | { step: "identify" }
  /** The code was sent. The challenge id is what ties the two requests together. */
  | {
      step: "code";
      challengeId: string;
      channel: Channel;
      /** Echoed back so a mistyped address is visible before they wait for mail. */
      sentTo: string;
    };

/**
 * Where to go once signed in.
 *
 * Only a same-origin destination is honoured. An open redirect matters more
 * here than anywhere else on the site: the person has just been asked to trust
 * a sign-in page, and a link that carried them somewhere else afterwards would
 * arrive with that trust attached.
 *
 * Resolved through the browser's own URL parser rather than a string test,
 * because the parser is what would perform the redirect. A hand-written check
 * for a leading `//` still lets `/\/evil.example` through — the backslash is
 * normalised to a slash during parsing, and the visitor leaves the site.
 */
function safeNext(value: string | null, locale: string): string {
  const fallback = `/${locale}`;
  if (!value) {
    return fallback;
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function SignInForm(props: {
  locale: string;
  phoneAuthEnabled: boolean;
}) {
  const t = useTranslations("auth");
  const errors = useTranslations("errors");
  const common = useTranslations("common");
  const router = useRouter();
  const params = useSearchParams();

  const [channel, setChannel] = useState<Channel>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [region, setRegion] = useState("");
  const [code, setCode] = useState("");

  const [stage, setStage] = useState<Stage>({ step: "identify" });
  const [sending, setSending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);

  function readFailure(body: unknown): {
    code: string;
    fields: Record<string, string[]>;
  } {
    const error = (body as { error?: { code?: string; fieldErrors?: Record<string, string[]> } })
      ?.error;
    return {
      code: error?.code ?? "unexpected",
      fields: error?.fieldErrors ?? {},
    };
  }

  async function requestCode(): Promise<void> {
    setSending(true);
    setFieldErrors({});
    setFailure(null);

    try {
      const response = await fetch(`/api/auth/${channel}/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          channel === "email"
            ? { email: email.trim(), locale: props.locale }
            : {
                phone: phone.trim(),
                region: region.trim().toUpperCase(),
                locale: props.locale,
              },
        ),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const failed = readFailure(body);
        setFieldErrors(failed.fields);
        setFailure(failed.code);
        return;
      }

      setCode("");
      setStage({
        step: "code",
        challengeId: body.data.challengeId,
        channel,
        sentTo: channel === "email" ? email.trim() : phone.trim(),
      });
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  async function verify(): Promise<void> {
    if (stage.step !== "code") {
      return;
    }

    setSending(true);
    setFieldErrors({});
    setFailure(null);

    try {
      const response = await fetch(`/api/auth/${stage.channel}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: stage.challengeId,
          code: code.trim(),
          locale: props.locale,
        }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const failed = readFailure(body);
        setFieldErrors(failed.fields);
        setFailure(failed.code);
        return;
      }

      const destination = safeNext(params.get("next"), props.locale);
      router.push(destination);
      // The header renders from the session cookie on the server, so the tree
      // above this page has to be re-fetched or it keeps offering "sign in".
      router.refresh();
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  function errorFor(field: string): string | null {
    return fieldErrors[field]?.[0] ?? null;
  }

  const failureText = failure
    ? errors.has(failure)
      ? errors(failure)
      : errors("unexpected")
    : null;

  if (stage.step === "code") {
    return (
      <form
        className="stack measure"
        onSubmit={(event) => {
          event.preventDefault();
          void verify();
        }}
      >
        <h2>{t("codeTitle")}</h2>
        {/*
         * The placeholder is named `email` in every catalog, and phone sign-in
         * reuses it rather than adding a second sentence to fifteen languages
         * for a channel phase one keeps hidden. The rendered line reads
         * correctly either way.
         */}
        <p className="muted">{t("codeSubtitle", { email: stage.sentTo })}</p>

        <label className="field">
          <span className="fieldLabel">{t("codeLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="numeric"
            // Lets a phone offer the code straight from the message or mail,
            // which matters most for the people least comfortable retyping it.
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
        </label>

        {errorFor("code") ? (
          <p className="fieldError" role="alert">
            {errorFor("code")}
          </p>
        ) : null}

        <p className="muted">{t("codeExpiry")}</p>

        <div className="ritualChoices">
          <button
            className="button buttonPrimary"
            type="submit"
            disabled={sending || code.length !== 6}
          >
            {sending ? common("loading") : t("verify")}
          </button>
          <button
            className="button buttonQuiet"
            type="button"
            disabled={sending}
            onClick={() => {
              setStage({ step: "identify" });
              setFailure(null);
              setFieldErrors({});
            }}
          >
            {t("resend")}
          </button>
        </div>

        {failureText ? (
          <p className="fieldError" role="alert">
            {failureText}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <form
      className="stack measure"
      onSubmit={(event) => {
        event.preventDefault();
        void requestCode();
      }}
    >
      {props.phoneAuthEnabled ? (
        <div className="ritualChoices">
          <button
            type="button"
            className={
              channel === "email" ? "button buttonPrimary" : "button buttonQuiet"
            }
            aria-pressed={channel === "email"}
            onClick={() => setChannel("email")}
          >
            {t("emailLabel")}
          </button>
          <button
            type="button"
            className={
              channel === "phone" ? "button buttonPrimary" : "button buttonQuiet"
            }
            aria-pressed={channel === "phone"}
            onClick={() => setChannel("phone")}
          >
            {t("phoneLabel")}
          </button>
        </div>
      ) : null}

      {channel === "email" ? (
        <label className="field">
          <span className="fieldLabel">{t("emailLabel")}</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
      ) : (
        <>
          <label className="field">
            <span className="fieldLabel">{t("phoneRegionLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={2}
              required
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("phoneLabel")}</span>
            <input
              className="input"
              type="tel"
              autoComplete="tel"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
        </>
      )}

      {errorFor("email") ? (
        <p className="fieldError" role="alert">
          {errorFor("email")}
        </p>
      ) : null}
      {errorFor("phone") ?? errorFor("region") ? (
        <p className="fieldError" role="alert">
          {errorFor("phone") ?? errorFor("region")}
        </p>
      ) : null}

      <div>
        <button
          className="button buttonPrimary"
          type="submit"
          disabled={sending}
        >
          {sending ? common("loading") : t("sendCode")}
        </button>
      </div>

      {failureText ? (
        <p className="fieldError" role="alert">
          {failureText}
        </p>
      ) : null}
    </form>
  );
}
