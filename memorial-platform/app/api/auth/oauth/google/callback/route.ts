import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requestIpHash, userAgentFrom } from "@/lib/api";
import { env } from "@/lib/env";
import { flags } from "@/lib/feature-flags";
import { setSessionCookie } from "@/modules/auth/cookies";
import { signInWithSocialProvider } from "@/modules/auth/oauth-service";
import { googleProvider } from "@/modules/auth/providers/google";
import { validateOAuthState } from "@/modules/auth/providers/oauth";

const OAUTH_STATE_COOKIE = "oauth_state";

export async function GET(request: Request): Promise<Response> {
  const appUrl = env().APP_URL;

  if (!flags().oauthGoogleEnabled) {
    return NextResponse.redirect(new URL("/", appUrl));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam || !code || !stateParam) {
    return NextResponse.redirect(new URL("/en/sign-in", appUrl));
  }

  const store = await cookies();
  const rawState = store.get(OAUTH_STATE_COOKIE)?.value;

  if (!rawState) {
    return NextResponse.redirect(new URL("/en/sign-in", appUrl));
  }

  let stored: { state: string; nonce: string; locale: string };
  try {
    stored = JSON.parse(rawState) as typeof stored;
  } catch {
    return NextResponse.redirect(new URL("/en/sign-in", appUrl));
  }

  const stateCheck = validateOAuthState({
    received: stateParam,
    expected: stored.state,
  });

  if (!stateCheck.ok) {
    return NextResponse.redirect(
      new URL(`/${stored.locale}/sign-in`, appUrl),
    );
  }

  try {
    const provider = googleProvider();
    const result = await provider.verifyCallback({
      code,
      state: stateParam,
      expectedState: stored.state,
      nonce: stored.nonce,
    });

    const session = await signInWithSocialProvider({
      provider: "google",
      providerSubject: result.providerSubject,
      email: result.email,
      emailVerified: result.emailVerified,
      locale: stored.locale,
      ipHash: requestIpHash(request),
      userAgent: userAgentFrom(request),
    });

    const response = NextResponse.redirect(
      new URL(`/${stored.locale}`, appUrl),
    );

    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: "",
      httpOnly: true,
      secure: appUrl.startsWith("https://"),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return setSessionCookie(response, {
      token: session.token,
      expiresAt: session.expiresAt,
    });
  } catch {
    return NextResponse.redirect(
      new URL(`/${stored.locale}/sign-in`, appUrl),
    );
  }
}
