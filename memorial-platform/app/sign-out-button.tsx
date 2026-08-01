"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Signing out.
 *
 * A button rather than a link, because it changes state on the server and a
 * link would let a prefetcher or a crawler end someone's session for them.
 */
export function SignOutButton(props: { locale: string }) {
  const nav = useTranslations("nav");
  const router = useRouter();
  const [sending, setSending] = useState(false);

  async function signOut(): Promise<void> {
    setSending(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Deliberately ignored. The refresh below re-reads the session either
      // way, so a failed request shows them still signed in rather than
      // claiming an ending that did not happen.
    } finally {
      setSending(false);
      // Home rather than the current page: whatever they were looking at may
      // need a session to render, and being bounced to a 404 is a poor way to
      // find out you have signed out.
      router.push(`/${props.locale}`);
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      className="linkButton"
      disabled={sending}
      onClick={signOut}
    >
      {nav("signOut")}
    </button>
  );
}
