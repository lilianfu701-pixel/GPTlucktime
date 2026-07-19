"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  validateBirthInputAction,
  type BirthValidationResult,
} from "../../app/actions/validate-birth-input";
import type {
  BirthInput,
  CivilTimeResolution,
  TimePrecision,
} from "../../core/types";
import { BIRTH_INPUT_LIMITS } from "../../lib/birth-input-limits";
import { useChartSession } from "../chart-session-provider";
import styles from "./birth-intake-form.module.css";

interface FormState {
  birthDate: string;
  birthTime: string;
  timePrecision: TimePrecision;
  birthplaceName: string;
  latitude: string;
  longitude: string;
  timeZone: string;
  civilTimeResolution: "" | CivilTimeResolution;
  residenceName: string;
  residenceLatitude: string;
  residenceLongitude: string;
  residenceTimeZone: string;
}

type FieldKey = Exclude<keyof FormState, "timePrecision" | "civilTimeResolution">;
type FieldErrors = Partial<Record<FieldKey, string>>;

type AuthorityState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "resolved"; result: BirthValidationResult }>;

const validationDebounceMilliseconds = 300;

const initialState: FormState = {
  birthDate: "",
  birthTime: "",
  timePrecision: "exact",
  birthplaceName: "",
  latitude: "",
  longitude: "",
  timeZone: "",
  civilTimeResolution: "",
  residenceName: "",
  residenceLatitude: "",
  residenceLongitude: "",
  residenceTimeZone: "",
};

function coordinateError(
  value: string,
  minimum: number,
  maximum: number,
  requiredMessage: string,
  rangeMessage: string,
): string | undefined {
  if (value.trim() === "") return requiredMessage;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    return rangeMessage;
  }
  return undefined;
}

function validateForm(state: FormState): Readonly<{
  errors: FieldErrors;
  input?: BirthInput;
  hasResidence: boolean;
}> {
  const errors: FieldErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(state.birthDate)) {
    errors.birthDate = state.birthDate ? "请输入有效的出生日期" : "请选择出生日期";
  }
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(state.birthTime)) {
    errors.birthTime = state.birthTime
      ? "请输入有效的出生时间"
      : "请输入出生时间";
  }
  if (`${state.birthDate}T${state.birthTime}`.length > BIRTH_INPUT_LIMITS.localDateTime) {
    errors.birthDate = "出生日期和时间内容过长";
    errors.birthTime = "出生日期和时间内容过长";
  }
  if (!state.birthplaceName.trim()) {
    errors.birthplaceName = "请输入出生地名称";
  } else if (state.birthplaceName.trim().length > BIRTH_INPUT_LIMITS.placeName) {
    errors.birthplaceName = "出生地名称不能超过 100 个字符";
  }
  errors.latitude = coordinateError(
    state.latitude,
    -90,
    90,
    "请输入出生地纬度",
    "纬度必须在 -90 到 90 之间",
  );
  errors.longitude = coordinateError(
    state.longitude,
    -180,
    180,
    "请输入出生地经度",
    "经度必须在 -180 到 180 之间",
  );
  if (!state.timeZone.trim()) {
    errors.timeZone = "请输入出生地 IANA 时区";
  } else if (state.timeZone.trim().length > BIRTH_INPUT_LIMITS.timeZone) {
    errors.timeZone = "出生地时区不能超过 100 个字符";
  }

  const residenceValues = [
    state.residenceName,
    state.residenceLatitude,
    state.residenceLongitude,
    state.residenceTimeZone,
  ];
  const hasResidence = residenceValues.some((value) => value.trim() !== "");
  if (hasResidence) {
    if (!state.residenceName.trim()) {
      errors.residenceName = "请补全生活地名称";
    } else if (state.residenceName.trim().length > BIRTH_INPUT_LIMITS.placeName) {
      errors.residenceName = "生活地名称不能超过 100 个字符";
    }
    errors.residenceLatitude = coordinateError(
      state.residenceLatitude,
      -90,
      90,
      "请补全生活地纬度",
      "纬度必须在 -90 到 90 之间",
    );
    errors.residenceLongitude = coordinateError(
      state.residenceLongitude,
      -180,
      180,
      "请补全生活地经度",
      "经度必须在 -180 到 180 之间",
    );
    if (!state.residenceTimeZone.trim()) {
      errors.residenceTimeZone = "请补全生活地 IANA 时区";
    } else if (
      state.residenceTimeZone.trim().length > BIRTH_INPUT_LIMITS.timeZone
    ) {
      errors.residenceTimeZone = "生活地时区不能超过 100 个字符";
    }
  }

  for (const key of Object.keys(errors) as FieldKey[]) {
    if (errors[key] === undefined) delete errors[key];
  }
  if (Object.keys(errors).length > 0) return { errors, hasResidence };

  const input: BirthInput = {
    localDateTime: `${state.birthDate}T${state.birthTime}`,
    timeZone: state.timeZone.trim(),
    birthplace: {
      name: state.birthplaceName.trim(),
      latitude: Number(state.latitude),
      longitude: Number(state.longitude),
    },
    timePrecision: state.timePrecision,
    ...(state.civilTimeResolution
      ? { civilTimeResolution: state.civilTimeResolution }
      : {}),
    ...(hasResidence
      ? {
          residenceContext: {
            name: state.residenceName.trim(),
            latitude: Number(state.residenceLatitude),
            longitude: Number(state.residenceLongitude),
            timeZone: state.residenceTimeZone.trim(),
          },
        }
      : {}),
  };
  return { errors, input, hasResidence };
}

interface InputFieldProps {
  id: FieldKey;
  label: string;
  type?: "text" | "date" | "time" | "number";
  value: string;
  error?: string;
  placeholder?: string;
  step?: string | number;
  inputMode?: "decimal" | "text";
  maxLength?: number;
  required?: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}

function InputField({
  id,
  label,
  type = "text",
  value,
  error,
  placeholder,
  step,
  inputMode,
  maxLength,
  required = false,
  onChange,
  onBlur,
}: InputFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        placeholder={placeholder}
        step={step}
        inputMode={inputMode}
        maxLength={maxLength}
        required={required}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function BirthIntakeForm() {
  const router = useRouter();
  const { setBirthInput } = useChartSession();
  const [state, setState] = useState<FormState>(initialState);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [authority, setAuthority] = useState<AuthorityState>({ status: "idle" });
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestVersion = useRef(0);
  const validation = validateForm(state);
  const authorityResult = authority.status === "resolved" ? authority.result : null;
  const authoritativeInput =
    authorityResult?.valid === true ? authorityResult.normalized : undefined;
  const authorityErrors =
    authorityResult?.valid === false ? authorityResult.fieldErrors : {};
  const resolutionError = authorityErrors.civilTimeResolution;

  useEffect(() => {
    const version = ++requestVersion.current;
    let active = true;
    if (!validation.input) {
      setAuthority({ status: "idle" });
      return () => {
        active = false;
      };
    }

    setAuthority({ status: "checking" });
    const timeout = window.setTimeout(() => {
      void validateBirthInputAction(validation.input)
        .then((result) => {
          if (active && version === requestVersion.current) {
            setAuthority({ status: "resolved", result });
          }
        })
        .catch(() => {
          if (active && version === requestVersion.current) {
            setAuthority({
              status: "resolved",
              result: {
                valid: false,
                code: "VALIDATION_UNAVAILABLE",
                message: "时间校验暂时不可用，请稍后重试",
                retryable: true,
                fieldErrors: {
                  form: "时间校验暂时不可用，请稍后重试",
                },
              },
            });
          }
        });
    }, validationDebounceMilliseconds);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [state, retryGeneration]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    ++requestVersion.current;
    setAuthority({ status: "idle" });
    setState((current) => ({ ...current, [key]: value }));
  }

  function markTouched(key: FieldKey): void {
    setTouched((current) => ({ ...current, [key]: true }));
  }

  function retryValidation(): void {
    ++requestVersion.current;
    setAuthority({ status: "idle" });
    setRetryGeneration((generation) => generation + 1);
  }

  function visibleError(key: FieldKey): string | undefined {
    const authorityError = authorityErrors[key];
    if (authorityError) return authorityError;
    return touched[key] ? validation.errors[key] : undefined;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!authoritativeInput) {
      setTouched(
        Object.fromEntries(
          (Object.keys(initialState) as (keyof FormState)[])
            .filter(
              (key): key is FieldKey =>
                key !== "timePrecision" && key !== "civilTimeResolution",
            )
            .map((key) => [key, true]),
        ),
      );
      return;
    }
    setBirthInput(authoritativeInput);
    router.push("/chart");
  }

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.kicker}>静态出生盘 · 校时录入</div>
        <div className={styles.titleRow}>
          <div>
            <h1>命盘推演</h1>
            <p className={styles.subtitle}>先校时，再排盘</p>
          </div>
          <div className={styles.seal} aria-hidden="true">
            校时
          </div>
        </div>
        <p className={styles.lede}>
          以出生地民用时间为起点，核对时区、经度与历史夏令时，再生成可追溯的出生固定命盘。
        </p>
      </header>

      <form
        className={styles.form}
        aria-label="出生资料录入"
        autoComplete="off"
        noValidate
        onSubmit={handleSubmit}
      >
        <section className={styles.primaryColumn} aria-labelledby="birth-heading">
          <div className={styles.sectionHeading}>
            <span>壹</span>
            <div>
              <h2 id="birth-heading">出生资料</h2>
              <p>填写当时当地钟表所显示的日期与时间。</p>
            </div>
          </div>

          <div className={styles.twoFields}>
            <InputField
              id="birthDate"
              label="出生日期"
              type="date"
              required
              value={state.birthDate}
              error={visibleError("birthDate")}
              onChange={(value) => update("birthDate", value)}
              onBlur={() => markTouched("birthDate")}
            />
            <InputField
              id="birthTime"
              label="出生时间（可含秒）"
              type="time"
              step="1"
              required
              value={state.birthTime}
              error={visibleError("birthTime")}
              onChange={(value) => update("birthTime", value)}
              onBlur={() => markTouched("birthTime")}
            />
          </div>

          <fieldset className={styles.precision}>
            <legend>出生时间精度</legend>
            <label>
              <input
                type="radio"
                name="timePrecision"
                value="exact"
                checked={state.timePrecision === "exact"}
                onChange={() => update("timePrecision", "exact")}
              />
              <span>精确</span>
            </label>
            <label>
              <input
                type="radio"
                name="timePrecision"
                value="approximate"
                checked={state.timePrecision === "approximate"}
                onChange={() => update("timePrecision", "approximate")}
              />
              <span>约略</span>
            </label>
            <label>
              <input
                type="radio"
                name="timePrecision"
                value="unknown"
                checked={state.timePrecision === "unknown"}
                onChange={() => update("timePrecision", "unknown")}
              />
              <span>未知</span>
            </label>
          </fieldset>

          <div className={styles.sectionHeading}>
            <span>贰</span>
            <div>
              <h2>出生地点</h2>
              <p>坐标用于经度校正，时区用于解析历史民用时间。</p>
            </div>
          </div>

          <InputField
            id="birthplaceName"
            label="出生地名称"
            maxLength={BIRTH_INPUT_LIMITS.placeName}
            required
            value={state.birthplaceName}
            error={visibleError("birthplaceName")}
            placeholder="例如：上海市"
            onChange={(value) => update("birthplaceName", value)}
            onBlur={() => markTouched("birthplaceName")}
          />
          <div className={styles.twoFields}>
            <InputField
              id="latitude"
              label="出生地纬度"
              type="number"
              step="any"
              inputMode="decimal"
              required
              value={state.latitude}
              error={visibleError("latitude")}
              placeholder="31.2304"
              onChange={(value) => update("latitude", value)}
              onBlur={() => markTouched("latitude")}
            />
            <InputField
              id="longitude"
              label="出生地经度"
              type="number"
              step="any"
              inputMode="decimal"
              required
              value={state.longitude}
              error={visibleError("longitude")}
              placeholder="121.4737"
              onChange={(value) => update("longitude", value)}
              onBlur={() => markTouched("longitude")}
            />
          </div>
          <InputField
            id="timeZone"
            label="出生地 IANA 时区"
            maxLength={BIRTH_INPUT_LIMITS.timeZone}
            required
            value={state.timeZone}
            error={visibleError("timeZone")}
            placeholder="例如：Asia/Shanghai"
            onChange={(value) => update("timeZone", value)}
            onBlur={() => markTouched("timeZone")}
          />
        </section>

        <aside className={styles.secondaryColumn} aria-label="校时补充资料">
          <section className={styles.privacy}>
            <div className={styles.sectionHeading}>
              <span>隐</span>
              <div>
                <h2>本次计算专用</h2>
                <p>客户端仅在当前 React 页面会话内存中保留资料。</p>
              </div>
            </div>
            <p>出生资料会发送到服务器内存执行校验和计算。</p>
            <p>不会写入 localStorage、sessionStorage、Cookie 或数据库。</p>
            <p>刷新或关闭页面会清除客户端状态。</p>
          </section>

          <section className={styles.residence} aria-labelledby="residence-heading">
            <div className={styles.sectionHeading}>
              <span>叁</span>
              <div>
                <h2 id="residence-heading">生活地（可选）</h2>
                <p>生活地不会改变出生固定命盘，仅为未来动态层预留。</p>
              </div>
            </div>
            <InputField
              id="residenceName"
              label="生活地名称（可选）"
              maxLength={BIRTH_INPUT_LIMITS.placeName}
              required={validation.hasResidence}
              value={state.residenceName}
              error={visibleError("residenceName")}
              placeholder="例如：洛杉矶"
              onChange={(value) => update("residenceName", value)}
              onBlur={() => markTouched("residenceName")}
            />
            <div className={styles.twoFields}>
              <InputField
                id="residenceLatitude"
                label="生活地纬度（可选）"
                type="number"
                step="any"
                inputMode="decimal"
                required={validation.hasResidence}
                value={state.residenceLatitude}
                error={visibleError("residenceLatitude")}
                placeholder="34.0522"
                onChange={(value) => update("residenceLatitude", value)}
                onBlur={() => markTouched("residenceLatitude")}
              />
              <InputField
                id="residenceLongitude"
                label="生活地经度（可选）"
                type="number"
                step="any"
                inputMode="decimal"
                required={validation.hasResidence}
                value={state.residenceLongitude}
                error={visibleError("residenceLongitude")}
                placeholder="-118.2437"
                onChange={(value) => update("residenceLongitude", value)}
                onBlur={() => markTouched("residenceLongitude")}
              />
            </div>
            <InputField
              id="residenceTimeZone"
              label="生活地 IANA 时区（可选）"
              maxLength={BIRTH_INPUT_LIMITS.timeZone}
              required={validation.hasResidence}
              value={state.residenceTimeZone}
              error={visibleError("residenceTimeZone")}
              placeholder="例如：America/Los_Angeles"
              onChange={(value) => update("residenceTimeZone", value)}
              onBlur={() => markTouched("residenceTimeZone")}
            />
          </section>

          <details className={styles.advanced} open={Boolean(resolutionError)}>
            <summary>高级校时选项</summary>
            <label htmlFor="civilTimeResolution">重复民用时间选择（可选）</label>
            <select
              id="civilTimeResolution"
              name="civilTimeResolution"
              value={state.civilTimeResolution}
              required={Boolean(resolutionError)}
              aria-invalid={resolutionError ? true : undefined}
              aria-describedby={
                resolutionError ? "civilTimeResolution-error" : undefined
              }
              onChange={(event) =>
                update(
                  "civilTimeResolution",
                  event.target.value as FormState["civilTimeResolution"],
                )
              }
            >
              <option value="">仅在夏令时重复时刻需要</option>
              <option value="earlier">较早一次 earlier</option>
              <option value="later">较晚一次 later</option>
            </select>
            {resolutionError ? (
              <p
                id="civilTimeResolution-error"
                className={styles.error}
                role="alert"
              >
                {resolutionError}
              </p>
            ) : null}
          </details>
        </aside>

        <footer className={styles.submitRow}>
          <div>
            <strong>提交前会先验证民用时间与时区。</strong>
            <span>本页不会展示命盘结果。</span>
            <p className={styles.validationStatus} role="status" aria-live="polite">
              {authority.status === "checking"
                ? "正在校验时区与民用时间…"
                : authorityResult?.valid === true
                  ? "时间与时区校验通过"
                  : authorityResult?.valid === false
                    ? authorityResult.message
                    : validation.input
                      ? "等待校验"
                      : "请完整填写必填资料"}
            </p>
            {authorityErrors.form ? (
              <p className={styles.error} role="alert">
                {authorityErrors.form}
              </p>
            ) : null}
            {authorityResult?.valid === false && authorityResult.retryable ? (
              <button
                type="button"
                className={styles.retryButton}
                onClick={retryValidation}
              >
                重新校验
              </button>
            ) : null}
          </div>
          <button type="submit" disabled={!authoritativeInput}>
            校验时间并生成命盘
          </button>
        </footer>
      </form>
    </main>
  );
}
