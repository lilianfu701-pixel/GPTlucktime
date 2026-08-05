import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { flags } from "@/lib/feature-flags";
import { googleProvider } from "@/modules/auth/providers/google";
import { createOAuthState } from "@/modules/auth/providers/oauth";

const OAUTH_STATE_COOKIE = "oauth_state";

export async function GET(request: Request): Promise<Response> {
  const config = env();

  if (!flags().oauthGoogleEnabled) {
    return NextResponse.redirect(new URL("/", config.APP_URL));
  }

  const url = new URL(request.url);
  const locale = url.searchParams.get("locale") ?? "en";

  const { state, nonce } = createOAuthState();
  const provider = googleProvider();
  const authUrl = provider.createAuthorizationUrl({ state, nonce, locale });

  const response = NextResponse.redirect(authUrl);

  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: JSON.stringify({ state, nonce, locale }),
    httpOnly: true,
    secure: config.APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return response;
}
