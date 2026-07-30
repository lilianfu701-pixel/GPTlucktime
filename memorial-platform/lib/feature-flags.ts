import { env } from "./env";
import type { Env } from "./env";

/**
 * Runtime feature switches.
 *
 * Derived from configuration today. Doc 09 section 9 requires high-risk
 * switches to be auditable and closable quickly, which will move the values
 * behind an administrative table later; the shape here is what callers depend
 * on, so that change stays contained.
 */
export type FeatureFlags = {
  phoneAuthEnabled: boolean;
  phoneAuthRegions: readonly string[];
  oauthGoogleEnabled: boolean;
  oauthAppleEnabled: boolean;
  machineTranslationEnabled: boolean;
  publicSearchEnabled: boolean;
  anniversaryNotificationsEnabled: boolean;
  premiumUiEnabled: boolean;
};

export function featureFlagsFrom(config: Env): FeatureFlags {
  return {
    // Phase one ships phone sign-in complete and tested, but hidden.
    phoneAuthEnabled: config.PHONE_AUTH_ENABLED,
    phoneAuthRegions: config.PHONE_AUTH_REGIONS,

    // A social provider is offered only when it can actually complete. Showing
    // a button that dead-ends at the provider is worse than not showing it.
    oauthGoogleEnabled: Boolean(
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
    ),
    oauthAppleEnabled: Boolean(
      config.APPLE_CLIENT_ID && config.APPLE_PRIVATE_KEY,
    ),

    // Machine translation may only produce drafts, never published religious
    // copy, so the surface stays closed until the review workflow exists.
    machineTranslationEnabled: false,

    // A public memorial is searchable by default.
    publicSearchEnabled: true,

    // Off unless deliberately configured. Reaching into someone's inbox on the
    // anniversary of a death is not a default.
    anniversaryNotificationsEnabled: config.ANNIVERSARY_NOTIFICATIONS_ENABLED,

    // No purchase path exists in phase one.
    premiumUiEnabled: false,
  };
}

export function flags(): FeatureFlags {
  return featureFlagsFrom(env());
}

/**
 * Whether phone sign-in may be offered for a region.
 *
 * Fails closed twice over: the global switch must be on, and the region must be
 * named explicitly. An operator who enables the switch but leaves the allow
 * list empty opens nothing.
 */
export function phoneAuthAllowedForRegion(
  featureFlags: FeatureFlags,
  region: string,
): boolean {
  if (!featureFlags.phoneAuthEnabled) {
    return false;
  }

  const normalized = region.trim().toUpperCase();
  if (normalized.length === 0) {
    return false;
  }

  return featureFlags.phoneAuthRegions.includes(normalized);
}
