import { demoConversations, demoCurrentUser, demoMatches, demoPlans, demoProfiles } from "./demo-data";
import type { DemoHome, DemoLocale } from "./demo-types";

const maxConversationContextLength = 64;

export function getDemoHome(locale: DemoLocale): DemoHome {
  return Object.freeze({ profiles: demoProfiles[locale], conversations: demoConversations[locale], matches: demoMatches[locale], plans: demoPlans[locale], currentUser: demoCurrentUser[locale] });
}

export function getDemoProfile(id: string, locale: DemoLocale) {
  return demoProfiles[locale].find((profile) => profile.id === id) ?? null;
}

export function getDemoConversationContext(profileId: string | undefined, locale: DemoLocale) {
  const home = getDemoHome(locale);
  const requestedId = profileId && profileId.length <= maxConversationContextLength ? profileId : undefined;
  const conversation = home.conversations.find((item) => item.profileId === requestedId || item.id === requestedId) ?? home.conversations[0];
  const profile = home.profiles.find((item) => item.id === conversation.profileId) ?? home.profiles[0];
  return { conversation, profile } as const;
}
