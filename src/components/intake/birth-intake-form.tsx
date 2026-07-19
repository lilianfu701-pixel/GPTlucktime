"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { normalizeBirthInput } from "../../core/input";
import { resolveCivilTime } from "../../core/time/civil-time";
import type {
  BirthInput,
  CivilTimeResolution,
  NormalizedBirthInput,
  TimePrecision,
} from "../../core/types";
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
  input?: NormalizedBirthInput;
  resolutionError?: string;
  showCivilTimeError?: boolean;
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
  if (!state.birthplaceName.trim()) errors.birthplaceName = "请输入出生地名称";
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
  if (!state.timeZone.trim()) errors.timeZone = "请输入出生地 IANA 时区";

  const residenceValues = [
    state.residenceName,
    state.residenceLatitude,
    state.residenceLongitude,
    state.residenceTimeZone,
  ];
  const hasResidence = residenceValues.some((value) => value.trim() !== "");
  if (hasResidence) {
    if (!state.residenceName.trim()) errors.residenceName = "请补全生活地名称";
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
    }
  }

  for (const key of Object.keys(errors) as FieldKey[]) {
    if (errors[key] === undefined) delete errors[key];
  }
  if (Object.keys(errors).length > 0) return { errors };

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
  const normalized = normalizeBirthInput(input);
  if (normalized.ok) {
    const civilTime = resolveCivilTime(
      normalized.value.localDateTime,
      normalized.value.timeZone,
      normalized.value.civilTimeResolution,
    );
    if (civilTime.ok) return { errors, input: normalized.value };

    if (civilTime.code === "DST_GAP") {
      const message = "该当地时间因夏令时切换而不存在，请调整出生时间";
      errors.birthDate = message;
      errors.birthTime = message;
      return { errors, showCivilTimeError: true };
    }
    if (civilTime.code === "DST_AMBIGUOUS") {
      return {
        errors,
        resolutionError: "该当地时间出现两次，必须选择较早或较晚一次",
      };
    }
    if (civilTime.code === "INVALID_TIME_ZONE") {
      errors.timeZone = "请输入有效的 IANA 地区时区，如 Asia/Shanghai";
      return { errors };
    }

    errors.birthDate = "请输入有效的出生日期";
    errors.birthTime = "请输入有效的出生时间";
    return { errors };
  }

  if (normalized.code === "INVALID_TIME_ZONE") {
    const birthOnly = normalizeBirthInput({ ...input, residenceContext: undefined });
    if (!birthOnly.ok && birthOnly.code === "INVALID_TIME_ZONE") {
      errors.timeZone = "请输入有效的 IANA 地区时区，如 Asia/Shanghai";
    } else {
      errors.residenceTimeZone = "请输入有效的生活地 IANA 地区时区";
    }
  } else if (normalized.code === "INVALID_COORDINATES") {
    errors.latitude = "请检查出生地或生活地坐标";
  } else {
    errors.birthDate = "请输入有效的出生日期";
    errors.birthTime = "请输入有效的出生时间";
  }
  return { errors };
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
  const validation = validateForm(state);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((current) => ({ ...current, [key]: value }));
  }

  function markTouched(key: FieldKey): void {
    setTouched((current) => ({ ...current, [key]: true }));
  }

  function visibleError(key: FieldKey): string | undefined {
    return touched[key] ||
      (validation.showCivilTimeError &&
        (key === "birthDate" || key === "birthTime"))
      ? validation.errors[key]
      : undefined;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!validation.input) {
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
    setBirthInput(validation.input);
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
                <p>资料仅保存在当前 React 页面会话内存中。</p>
              </div>
            </div>
            <p>资料仅保存在本次页面会话内存中，用于本次计算。</p>
            <p>不会写入 localStorage、sessionStorage、Cookie 或数据库。</p>
            <p>刷新或关闭页面即清除。</p>
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
              value={state.residenceTimeZone}
              error={visibleError("residenceTimeZone")}
              placeholder="例如：America/Los_Angeles"
              onChange={(value) => update("residenceTimeZone", value)}
              onBlur={() => markTouched("residenceTimeZone")}
            />
          </section>

          <details className={styles.advanced} open={Boolean(validation.resolutionError)}>
            <summary>高级校时选项</summary>
            <label htmlFor="civilTimeResolution">重复民用时间选择（可选）</label>
            <select
              id="civilTimeResolution"
              name="civilTimeResolution"
              value={state.civilTimeResolution}
              aria-invalid={validation.resolutionError ? true : undefined}
              aria-describedby={
                validation.resolutionError ? "civilTimeResolution-error" : undefined
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
            {validation.resolutionError ? (
              <p
                id="civilTimeResolution-error"
                className={styles.error}
                role="alert"
              >
                {validation.resolutionError}
              </p>
            ) : null}
          </details>
        </aside>

        <footer className={styles.submitRow}>
          <div>
            <strong>提交前会先验证民用时间与时区。</strong>
            <span>本页不会展示命盘结果。</span>
          </div>
          <button type="submit" disabled={!validation.input}>
            校验时间并生成命盘
          </button>
        </footer>
      </form>
    </main>
  );
}
