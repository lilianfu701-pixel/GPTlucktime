"use server";

import { normalizeBirthInput } from "../../core/input";
import { resolveCivilTime } from "../../core/time/civil-time";
import type { NormalizedBirthInput } from "../../core/types";
import { checkBirthValidationRateLimit } from "../../server/birth-validation-rate-limit";

export type BirthValidationField =
  | "birthDate"
  | "birthTime"
  | "birthplaceName"
  | "latitude"
  | "longitude"
  | "timeZone"
  | "civilTimeResolution"
  | "residenceName"
  | "residenceLatitude"
  | "residenceLongitude"
  | "residenceTimeZone"
  | "form";

export type BirthValidationCode =
  | "INVALID_INPUT"
  | "INVALID_COORDINATES"
  | "INVALID_TIME_ZONE"
  | "INVALID_CIVIL_TIME_RESOLUTION"
  | "INVALID_LOCAL_DATE_TIME"
  | "DST_GAP"
  | "DST_AMBIGUOUS"
  | "RATE_LIMITED"
  | "VALIDATION_UNAVAILABLE";

export type BirthValidationResult =
  | Readonly<{
      valid: true;
      normalized: NormalizedBirthInput;
    }>
  | Readonly<{
      valid: false;
      code: BirthValidationCode;
      message: string;
      retryable: boolean;
      fieldErrors: Readonly<Partial<Record<BirthValidationField, string>>>;
    }>;

function failure(
  code: BirthValidationCode,
  message: string,
  fieldErrors: Partial<Record<BirthValidationField, string>>,
  retryable = false,
): BirthValidationResult {
  return { valid: false, code, message, retryable, fieldErrors };
}

function withoutResidence(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  return { ...input, residenceContext: undefined };
}

export async function validateBirthInputAction(
  input: unknown,
): Promise<BirthValidationResult> {
  try {
    const rateLimit = await checkBirthValidationRateLimit();
    if (!rateLimit.allowed) {
      const message = "校验请求过于频繁，请稍后重试";
      return failure("RATE_LIMITED", message, { form: message }, true);
    }

    const normalized = normalizeBirthInput(input);
    if (!normalized.ok) {
      if (normalized.code === "INVALID_TIME_ZONE") {
        const birthOnly = normalizeBirthInput(withoutResidence(input));
        const field =
          !birthOnly.ok && birthOnly.code === "INVALID_TIME_ZONE"
            ? "timeZone"
            : "residenceTimeZone";
        return failure(
          "INVALID_TIME_ZONE",
          "请检查时区后重试。",
          {
            [field]:
              field === "timeZone"
                ? "请输入有效的 IANA 地区时区，如 Asia/Shanghai"
                : "请输入有效的生活地 IANA 地区时区",
          },
        );
      }
      if (normalized.code === "INVALID_COORDINATES") {
        return failure(
          "INVALID_COORDINATES",
          "请检查地点坐标后重试。",
          { form: "地点坐标超出支持范围，请检查后重试" },
        );
      }
      return failure(
        "INVALID_INPUT",
        "请检查出生资料后重试。",
        { form: "出生资料不完整或格式无效，请检查后重试" },
      );
    }

    const civilTime = resolveCivilTime(
      normalized.value.localDateTime,
      normalized.value.timeZone,
      normalized.value.civilTimeResolution,
    );
    if (civilTime.ok) {
      return { valid: true, normalized: normalized.value };
    }

    if (civilTime.code === "DST_GAP") {
      const message = "该当地时间因夏令时切换而不存在，请调整出生时间";
      return failure("DST_GAP", message, {
        birthDate: message,
        birthTime: message,
      });
    }
    if (civilTime.code === "DST_AMBIGUOUS") {
      const message = "该当地时间出现两次，必须选择较早或较晚一次";
      return failure("DST_AMBIGUOUS", message, {
        civilTimeResolution: message,
      });
    }
    if (civilTime.code === "INVALID_TIME_ZONE") {
      return failure("INVALID_TIME_ZONE", "请检查时区后重试。", {
        timeZone: "请输入有效的 IANA 地区时区，如 Asia/Shanghai",
      });
    }
    if (civilTime.code === "INVALID_CIVIL_TIME_RESOLUTION") {
      return failure(
        "INVALID_CIVIL_TIME_RESOLUTION",
        "请重新选择重复民用时间。",
        { civilTimeResolution: "只能选择较早或较晚一次" },
      );
    }
    return failure(
      "INVALID_LOCAL_DATE_TIME",
      "请检查出生日期和时间后重试。",
      {
        birthDate: "请输入有效的出生日期",
        birthTime: "请输入有效的出生时间",
      },
    );
  } catch {
    return failure(
      "VALIDATION_UNAVAILABLE",
      "时间校验暂时不可用，请稍后重试",
      { form: "时间校验暂时不可用，请稍后重试" },
      true,
    );
  }
}
