import { z } from "zod";

// ISO 3166-1 alpha-2 assigned country codes. A regex alone would accept values such as ZZ.
export const ISO_COUNTRY_CODES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(
    " ",
  ),
);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day;
}, "invalid calendar date");

const inclusiveCode = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/);
const countryCode = z.string().trim().toUpperCase().refine(
  (value) => ISO_COUNTRY_CODES.has(value),
  "unknown ISO country code",
);
const uniqueCodes = <T extends z.ZodTypeAny>(schema: T, max: number) =>
  z.array(schema).max(max).refine((values) => new Set(values).size === values.length, "duplicate code");

export const profilePreferencesSchema = z.object({
  genderCodes: uniqueCodes(inclusiveCode, 30).default([]),
  minimumAge: z.number().int().min(18).max(120).default(18),
  maximumAge: z.number().int().min(18).max(120).default(100),
  preferredCountryCodes: uniqueCodes(countryCode, ISO_COUNTRY_CODES.size).default([]),
  languageCodes: uniqueCodes(
    z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    20,
  ).default([]),
  relationshipGoalCodes: uniqueCodes(inclusiveCode, 30).default([]),
}).refine((value) => value.minimumAge <= value.maximumAge, {
  message: "minimumAge must not exceed maximumAge",
  path: ["minimumAge"],
});

export const privacySettingsSchema = z.object({
  showOnlineStatus: z.boolean().default(true),
  showLastActive: z.boolean().default(true),
  showProfileVisitors: z.boolean().default(true),
  locationPrecision: z.enum(["hidden", "country", "city", "approximate"]).default("city"),
});

const patchFields = z.object({
  displayName: z.string().trim().min(1).max(80),
  birthDate: dateOnly,
  genderCode: inclusiveCode,
  relationshipGoalCode: inclusiveCode.nullable(),
  countryCode,
  city: z.string().trim().min(1).max(120).nullable(),
  bio: z.string().trim().max(2_000).nullable(),
  languageCodes: uniqueCodes(
    z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    20,
  ),
  interestCodes: uniqueCodes(inclusiveCode, 50),
  discoverable: z.boolean(),
  preferences: profilePreferencesSchema,
  privacy: privacySettingsSchema,
});

export const profilePatchSchema = patchFields.partial().strict();
export const completeProfileSchema = patchFields.pick({
  displayName: true,
  birthDate: true,
  genderCode: true,
  relationshipGoalCode: true,
  countryCode: true,
  city: true,
  bio: true,
  languageCodes: true,
  interestCodes: true,
  discoverable: true,
}).partial({
  relationshipGoalCode: true,
  city: true,
  bio: true,
  languageCodes: true,
  interestCodes: true,
  discoverable: true,
});

export const photoUploadRequestSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const photoCompleteRequestSchema = z.object({
  uploadId: z.string().uuid(),
  uploadToken: z.string().min(20).max(500),
}).strict();

export type ProfilePatch = z.infer<typeof profilePatchSchema>;
export type ProfilePreferencesInput = z.infer<typeof profilePreferencesSchema>;
export type PrivacySettingsInput = z.infer<typeof privacySettingsSchema>;
