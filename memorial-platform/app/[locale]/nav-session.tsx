"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SignOutButton } from "../sign-out-button";

type NavState = { signedIn: boolean; unread: number; isAdmin: boolean };

/*
 * The session-dependent part of the nav is fetched on the client so the
 * surrounding page HTML stays user-agnostic and can be edge-cached (doc: China
 * latency — a bare-domain visitor should get the cached page from a nearby PoP
 * instead of a fresh US render). Anonymous is the common case, so we render the
 * sign-in link immediately and swap in the signed-in cluster once known.
 */
export function NavSession(props: { locale: string }) {
  const nav = useTranslations("nav");
  const [state, setState] = useState<NavState | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      fetch("/api/nav-state", { credentials: "include", cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<NavState>) : null))
        .then((data) => {
          if (alive && data) {
            setState(data);
          }
        })
        .catch(() => {
          // Keep the last known state on any failure.
        });
    };
    load();
    // The layout stays mounted across client navigations, so the nav would
    // otherwise never update. Refresh it when auth changes (sign in / sign out
    // dispatch "auth-changed"), when the inbox marks something read, and when
    // the tab regains focus.
    window.addEventListener("auth-changed", load);
    window.addEventListener("inbox-read", load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("auth-changed", load);
      window.removeEventListener("inbox-read", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (!state?.signedIn) {
    return <Link href={`/${props.locale}/sign-in`}>{nav("signIn")}</Link>;
  }

  return (
    <>
      <Link href={`/${props.locale}/memorials`}>{nav("myMemorials")}</Link>
      <Link href={`/${props.locale}/inbox`} className="navInbox">
        {nav("inbox")}
        {state.unread > 0 ? (
          <span className="navBadge" aria-hidden="true">
            {state.unread > 99 ? "99+" : state.unread}
          </span>
        ) : null}
      </Link>
      <Link href={`/${props.locale}/account`}>{nav("myAccount")}</Link>
      {state.isAdmin ? (
        <Link className="navAdmin" href={`/${props.locale}/admin`}>
          {nav("admin")}
        </Link>
      ) : null}
      <SignOutButton locale={props.locale} />
    </>
  );
}
