import { LocalDateTime } from "@js-joda/core";
import { z } from "zod";

import { BIRTH_INPUT_LIMITS } from "../lib/birth-input-limits";
import { getTzDatabase } from "./time/tz-database";
import type {
  BirthInput,
  InputErrorCode,
  InputResult,
  NormalizedBirthInput,
} from "./types";

export type {
  BirthInput,
  CivilTimeResolution,
  InputResult,
  ResidenceContext,
  TimePrecision,
} from "./types";

const localDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

const coordinateSchema = z.object({
  name: z.string().trim().min(1).max(BIRTH_INPUT_LIMITS.placeName),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

const residenceContextSchema = coordinateSchema.extend({
  timeZone: z.string().trim().min(1).max(BIRTH_INPUT_LIMITS.timeZone),
});

const birthInputSchema = z.object({
  localDateTime: z
    .string()
    .max(BIRTH_INPUT_LIMITS.localDateTime)
    .refine(isLocalDateTime, {
      message: "Enter an ISO local date-time without a UTC offset.",
    }),
  timeZone: z.string().trim().min(1).max(BIRTH_INPUT_LIMITS.timeZone),
  birthplace: coordinateSchema,
  timePrecision: z.enum(["exact", "approximate", "unknown"]).optional(),
  civilTimeResolution: z.enum(["earlier", "later"]).optional(),
  residenceContext: residenceContextSchema.optional(),
});

function isLocalDateTime(value: string): boolean {
  if (!localDateTimePattern.test(value)) {
    return false;
  }

  try {
    LocalDateTime.parse(value);
    return true;
  } catch {
    return false;
  }
}

function hasCoordinateIssue(issues: z.core.$ZodIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.path.includes("latitude") || issue.path.includes("longitude"),
  );
}

function failure(code: InputErrorCode, message: string): InputResult {
  return Object.freeze({ ok: false as const, code, message });
}

function freezeNormalizedInput(
  input: z.output<typeof birthInputSchema>,
): NormalizedBirthInput {
  const birthplace = Object.freeze({ ...input.birthplace });
  const residenceContext = input.residenceContext
    ? Object.freeze({ ...input.residenceContext })
    : undefined;

  return Object.freeze({
    localDateTime: input.localDateTime,
    timeZone: input.timeZone,
    birthplace,
    ...(input.timePrecision === undefined
      ? {}
      : { timePrecision: input.timePrecision }),
    ...(input.civilTimeResolution === undefined
      ? {}
      : { civilTimeResolution: input.civilTimeResolution }),
    ...(residenceContext === undefined ? {} : { residenceContext }),
  });
}

function hasValidTimeZone(timeZone: string): boolean {
  try {
    return getTzDatabase().exists(timeZone);
  } catch {
    return false;
  }
}

/** Normalizes untrusted form data without allowing invalid user input to throw. */
export function normalizeBirthInput(input: unknown): InputResult {
  try {
    const parsed = birthInputSchema.safeParse(input);

    if (!parsed.success) {
      return hasCoordinateIssue(parsed.error.issues)
        ? failure("INVALID_COORDINATES", "Latitude or longitude is out of range.")
        : failure("INVALID_INPUT", "Birth details are incomplete or malformed.");
    }

    if (!hasValidTimeZone(parsed.data.timeZone)) {
      return failure("INVALID_TIME_ZONE", "Birth time zone must be a valid IANA ID.");
    }

    if (
      parsed.data.residenceContext &&
      !hasValidTimeZone(parsed.data.residenceContext.timeZone)
    ) {
      return failure(
        "INVALID_TIME_ZONE",
        "Residence time zone must be a valid IANA ID.",
      );
    }

    return Object.freeze({
      ok: true as const,
      value: freezeNormalizedInput(parsed.data),
    });
  } catch {
    return failure("INVALID_INPUT", "Birth details are incomplete or malformed.");
  }
}
