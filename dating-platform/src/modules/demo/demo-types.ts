export type DemoLocale = "en" | "zh-CN";

export type DemoProfile = Readonly<{
  id: string;
  name: string;
  age: number;
  city: string;
  country: string;
  relationshipGoal: string;
  occupation: string;
  bio: string;
  interests: readonly string[];
  verified: boolean;
  online: boolean;
  compatibility: number;
  spritePosition: `${number}% ${number}%`;
}>;

export type DemoMessage = Readonly<{ id: string; from: "me" | "them"; text: string; time: string }>;
export type DemoConversation = Readonly<{
  id: string;
  profileId: string;
  unread: number;
  preview: string;
  messages: readonly DemoMessage[];
}>;
export type DemoMatch = Readonly<{ profileId: string; matchedAt: string }>;
export type DemoPlan = Readonly<{ id: "free" | "plus" | "premium"; name: string; price: string; description: string; features: readonly string[]; recommended: boolean }>;
export type DemoCurrentUser = Readonly<{ name: string; age: number; city: string; completion: number; plan: string; bio: string; interests: readonly string[] }>;
export type DemoHome = Readonly<{ profiles: readonly DemoProfile[]; conversations: readonly DemoConversation[]; matches: readonly DemoMatch[]; plans: readonly DemoPlan[]; currentUser: DemoCurrentUser }>;
