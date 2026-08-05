import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "@/lib/env";
import type { OAuthProvider } from "./oauth";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export function googleProvider(): OAuthProvider {
  const config = env();
  const clientId = config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  return {
    id: "google",

    createAuthorizationUrl({ state, nonce, locale }) {
      const url = new URL(GOOGLE_AUTH_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set(
        "redirect_uri",
        `${config.APP_URL}/api/auth/oauth/google/callback`,
      );
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("prompt", "select_account");
      if (locale) {
        url.searchParams.set("hl", locale);
      }
      return url;
    },

    async verifyCallback({ code, nonce }) {
      const config = env();

      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: `${config.APP_URL}/api/auth/oauth/google/callback`,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error("Google token exchange failed");
      }

      const tokens = (await tokenResponse.json()) as { id_token: string };

      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
      });

      if (payload.nonce !== nonce) {
        throw new Error("Nonce mismatch");
      }

      return {
        providerSubject: payload.sub!,
        email: (payload.email as string) ?? null,
        emailVerified: (payload.email_verified as boolean) ?? false,
      };
    },
  };
}
