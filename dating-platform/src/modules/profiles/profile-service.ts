import { completeProfileSchema, profilePatchSchema } from "./profile-schema";
import type { ProfileRepository } from "./profile-repository";

export type DateBoundary = (birthYear: number, month: number, day: number, adultYear: number) => {
  month: number;
  day: number;
};

const parseDateOnly = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_BIRTH_DATE");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    throw new Error("INVALID_BIRTH_DATE");
  }
  return { year: year!, month: month!, day: day! };
};

export const utcLegalAdultBoundary: DateBoundary = (_birthYear, month, day, adultYear) => {
  if (month === 2 && day === 29) {
    const leap = adultYear % 4 === 0 && (adultYear % 100 !== 0 || adultYear % 400 === 0);
    if (!leap) return { month: 2, day: 28 };
  }
  return { month, day };
};

export function assertAdult(
  birthDate: string,
  now = new Date(),
  boundary: DateBoundary = utcLegalAdultBoundary,
) {
  const birth = parseDateOnly(birthDate);
  const adultYear = birth.year + 18;
  const adultDay = boundary(birth.year, birth.month, birth.day, adultYear);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const eligibleAt = Date.UTC(adultYear, adultDay.month - 1, adultDay.day);
  if (today < eligibleAt) throw new Error("AGE_RESTRICTED");
}

const PUBLIC_FIELDS = [
  "id",
  "displayName",
  "city",
  "countryCode",
  "age",
  "ageBand",
  "genderCode",
  "relationshipGoalCode",
  "bio",
  "languageCodes",
  "interestCodes",
  "photos",
] as const;

export function publicProfile(input: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const field of PUBLIC_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (field === "photos") {
      output.photos = Array.isArray(value) ? value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const photo = entry as Record<string, unknown>;
        if (photo.moderationStatus !== "approved") return [];
        const safe: Record<string, unknown> = {};
        for (const key of ["id", "url", "width", "height"] as const) {
          if (photo[key] !== undefined && photo[key] !== null) safe[key] = photo[key];
        }
        return [safe];
      }) : [];
    } else if (field === "languageCodes" || field === "interestCodes") {
      output[field] = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    } else {
      output[field] = value;
    }
  }
  return output;
}

const COMPLETENESS_FIELDS = [
  "displayName",
  "birthDate",
  "genderCode",
  "countryCode",
  "city",
  "bio",
  "languageCodes",
  "interestCodes",
] as const;

export function calculateProfileCompleteness(input: Record<string, unknown>) {
  const completed = COMPLETENESS_FIELDS.filter((field) => {
    const value = input[field];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : false;
  }).length;
  return { completed, total: COMPLETENESS_FIELDS.length, percent: Math.round(completed / COMPLETENESS_FIELDS.length * 100) };
}

export function profileVisibility(input: {
  accountStatus: string;
  profileStatus: string;
  discoverable: boolean;
  approvedPhotoCount: number;
}) {
  return input.accountStatus === "active"
    && input.profileStatus === "active"
    && input.discoverable
    && input.approvedPhotoCount > 0;
}

export function validateProfilePatch(input: unknown, now = new Date()) {
  const result = completeProfileSchema.partial().safeParse(input);
  if (!result.success) throw new Error("INVALID_PROFILE");
  if (result.data.birthDate) assertAdult(result.data.birthDate, now);
  return result.data;
}

type ProfileSession = { user: { id: string } };

const handlerError = (code: string, status: number) =>
  Response.json({ code, message: code }, { status });

export function createProfileHandler(input: {
  getSession(headers: Headers): Promise<ProfileSession | null>;
  repository: Pick<ProfileRepository, "getForUser" | "upsertForUser">;
  clock?: () => Date;
}) {
  return async (request: Request) => {
    let session: ProfileSession | null;
    try {
      session = await input.getSession(request.headers);
    } catch {
      return handlerError("INTERNAL_ERROR", 500);
    }
    if (!session) return handlerError("UNAUTHORIZED", 401);

    if (request.method === "GET") {
      try {
        const profile = await input.repository.getForUser(session.user.id);
        return profile ? Response.json({ profile }) : handlerError("PROFILE_INCOMPLETE", 409);
      } catch {
        return handlerError("INTERNAL_ERROR", 500);
      }
    }

    if (request.method !== "PATCH") return handlerError("METHOD_NOT_ALLOWED", 405);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return handlerError("INVALID_PROFILE", 400);
    }
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) return handlerError("INVALID_PROFILE", 400);
    try {
      if (parsed.data.birthDate) assertAdult(parsed.data.birthDate, input.clock?.() ?? new Date());
      const profile = await input.repository.upsertForUser(session.user.id, parsed.data);
      return Response.json({ profile });
    } catch (error) {
      if (error instanceof Error && error.message === "AGE_RESTRICTED") {
        return handlerError("AGE_RESTRICTED", 400);
      }
      if (error instanceof Error && error.message === "PROFILE_INCOMPLETE") {
        return handlerError("PROFILE_INCOMPLETE", 409);
      }
      return handlerError("INTERNAL_ERROR", 500);
    }
  };
}
