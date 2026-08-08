import { z } from "zod";

export const DISCOVERY_MODES = ["recommended", "new", "nearby", "online", "verified"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

const code = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/);
const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const unique = <T extends z.ZodTypeAny>(item: T, maximum: number) =>
  z.array(item).max(maximum).refine((items) => new Set(items).size === items.length, "duplicate filter");

const discoveryFilterFields = {
  mode: z.enum(DISCOVERY_MODES).default("recommended"),
  minimumAge: z.number().int().min(18).max(120).default(18),
  maximumAge: z.number().int().min(18).max(120).default(100),
  genderCodes: unique(code, 30).default([]),
  countryCodes: unique(countryCode, 50).default([]),
  relationshipGoalCodes: unique(code, 30).default([]),
  languageCodes: unique(z.string().trim().min(2).max(35), 20).default([]),
};

export const publicDiscoveryFilterSchema = z.object({
  ...discoveryFilterFields,
  pageSize: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(20).max(2_000).optional(),
}).strict().refine((value) => value.minimumAge <= value.maximumAge, {
  path: ["minimumAge"],
  message: "minimumAge must not exceed maximumAge",
});

export const savedDiscoveryFilterSchema = z.object(discoveryFilterFields).strict()
  .refine((value) => value.minimumAge <= value.maximumAge, {
    path: ["minimumAge"],
    message: "minimumAge must not exceed maximumAge",
  });

export type DiscoveryFilters = z.infer<typeof publicDiscoveryFilterSchema>;
export type SavedDiscoveryFilters = z.output<typeof savedDiscoveryFilterSchema>;

export type DiscoveryPreferences = {
  minimumAge: number;
  maximumAge: number;
  genderCodes: string[];
  preferredCountryCodes?: string[];
};

export type CandidatePolicyPerson = {
  userId: string;
  birthDate: string;
  genderCode: string;
  countryCode: string;
  status: string;
  discoverable: boolean;
  approvedPhotoCount: number;
  accountStatus?: string;
  preferences: DiscoveryPreferences;
};

export type CandidatePolicyInput = {
  viewer: CandidatePolicyPerson;
  candidate: CandidatePolicyPerson;
  viewerBlockedCandidate?: boolean;
  candidateBlockedViewer?: boolean;
  disabledRegion?: boolean;
  now?: Date;
};
