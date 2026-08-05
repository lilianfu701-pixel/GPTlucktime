"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Stage =
  | { step: "email" }
  | { step: "code"; challengeId: string; sentTo: string };

export function HomeSignIn(props: {
  locale: string;
  googleEnabled: boolean;
}) {
  const t = useTranslations("auth");
  const home = useTranslations("home");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "email" });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function requestCode(): Promise<void> {
    setSending(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/email/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), locale: props.locale }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setFailure("INVALID_EMAIL");
        return;
      }
      setCode("");
      setStage({
        step: "code",
        challengeId: (body as { data: { challengeId: string } }).data
          .challengeId,
        sentTo: email.trim(),
      });
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  async function verify(): Promise<void> {
    if (stage.step !== "code") return;
    setSending(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: stage.challengeId,
          code: code.trim(),
          locale: props.locale,
        }),
      });
      if (!res.ok) {
        setFailure("INVALID_CODE");
        return;
      }
      router.push(`/${props.locale}`);
      router.refresh();
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  const failureText = failure
    ? errors.has(failure)
      ? errors(failure)
      : errors("unexpected")
    : null;

  if (stage.step === "code") {
    return (
      <div className="homeSignIn">
        <form
          className="homeSignInForm"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="muted">{t("codeSubtitle", { email: stage.sentTo })}</p>
          <div className="homeSignInRow">
            <input
              className="input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              placeholder={t("codeLabel")}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
            />
            <button
              className="button buttonPrimary"
              type="submit"
              disabled={sending || code.length !== 6}
            >
              {sending ? common("loading") : t("verify")}
            </button>
          </div>
          <button
            className="linkButton"
            type="button"
            disabled={sending}
            onClick={() => {
              setStage({ step: "email" });
              setFailure(null);
            }}
          >
            {t("resend")}
          </button>
          {failureText ? (
            <p className="fieldError" role="alert">
              {failureText}
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div className="homeSignIn">
      <p className="homeSignInTitle">{home("signUpPrompt")}</p>

      <form
        className="homeSignInForm"
        onSubmit={(e) => {
          e.preventDefault();
          void requestCode();
        }}
      >
        <div className="homeSignInRow">
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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

      {props.googleEnabled ? (
        <>
          <span className="homeSignInDivider">
            {t("alternativeDivider")}
          </span>
          <a
            className="button buttonQuiet homeSignInGoogle"
            href={`/api/auth/oauth/google?locale=${props.locale}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              aria-hidden="true"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {t("continueWithGoogle")}
          </a>
        </>
      ) : null}
    </div>
  );
}
