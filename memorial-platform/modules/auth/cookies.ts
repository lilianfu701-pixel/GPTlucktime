import type { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE_NAME } from "./sessions";

/**
 * Attaches the session cookie.
 *
 * `httpOnly` keeps the token away from page scripts, so an injected script
 * cannot read it. `secure` follows the configured origin: forcing it on would
 * silently break sign-in over plain http in local development, and hard-coding
 * it off would ship a token that travels in the clear.
 *
 * `sameSite: "lax"` still sends the cookie on the top-level redirect back from a
 * social provider, which `"strict"` would drop, while withholding it from
 * cross-site subrequests.
 */
export function setSessionCookie(
  response: NextResponse,
  input: { token: string; expiresAt: Date },
): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: input.token,
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    expires: input.expiresAt,
  });
  return response;
}

export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
