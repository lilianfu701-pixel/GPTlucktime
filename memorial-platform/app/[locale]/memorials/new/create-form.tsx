"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Relationship = "spouse" | "parent" | "child" | "sibling";
type PlaceKind = "birth" | "death" | "lived" | "resting_place";

const PLACE_KINDS: { value: PlaceKind; key: string }[] = [
  { value: "birth", key: "placeKindBirth" },
  { value: "death", key: "placeKindDeath" },
  { value: "lived", key: "placeKindLived" },
  { value: "resting_place", key: "placeKindResting" },
];
type Precision = "unknown" | "year" | "approximate" | "month" | "day";
type Visibility = "public" | "unlisted" | "invite_only";

type PartialDateInput = { precision: Precision; raw: string };

const RELATIONSHIPS: Relationship[] = ["spouse", "parent", "child", "sibling"];
const PRECISIONS: Precision[] = ["day", "month", "year", "approximate", "unknown"];

const EMPTY_DATE: PartialDateInput = { precision: "unknown", raw: "" };

/**
 * Turns what the form collected into what the API accepts.
 *
 * A precision coarser than a day still sends a full ISO date, with the finer
 * components as placeholders — the stored precision is what decides how it is
 * ever displayed. Returning `undefined` for `unknown` matters: the endpoint
 * requires a real `YYYY-MM-DD` when the field is present at all, so an unknown
 * date has to be absent rather than empty.
 */
function toPartialDate(
  input: PartialDateInput,
): { value: string; precision: Precision } | undefined {
  if (input.precision === "unknown" || input.raw.trim() === "") {
    return undefined;
  }

  if (input.precision === "day") {
    return { value: input.raw, precision: "day" };
  }

  if (input.precision === "month") {
    // <input type="month"> yields YYYY-MM.
    return { value: `${input.raw}-01`, precision: "month" };
  }

  const year = input.raw.padStart(4, "0").slice(0, 4);
  return { value: `${year}-01-01`, precision: input.precision };
}

export function CreateMemorialForm(props: { locale: string }) {
  const t = useTranslations("memorial");
  const privacy = useTranslations("privacy");
  const errors = useTranslations("errors");
  const search = useTranslations("search");
  const common = useTranslations("common");
  // Deliberately not `memorial.publish`. This button creates a draft only the
  // family can see; the one that says "publish" lives on the memorial itself.
  const home = useTranslations("home");
  const router = useRouter();

  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [name, setName] = useState("");
  const [birth, setBirth] = useState<PartialDateInput>(EMPTY_DATE);
  const [death, setDeath] = useState<PartialDateInput>(EMPTY_DATE);
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  /*
   * Asked, not assumed. This defaulted to "death" while the field was labelled
   * only "Place", so a family entering where someone was born had it recorded
   * as where they died — wrong in the record, and wrong in a way nothing on
   * the page would ever have shown them.
   */
  const [placeKind, setPlaceKind] = useState<PlaceKind>("birth");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [indexable, setIndexable] = useState(true);
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [declared, setDeclared] = useState(false);

  const [sending, setSending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * One key per distinct submission, reused while the submission is unchanged.
   *
   * Both halves matter. Reusing it across a retry is what stops a dropped
   * connection from creating two memorials for one death. Minting a new one
   * after the visitor edits a field is what stops the corrected version from
   * being rejected as a conflicting replay of the first.
   */
  const attempt = useRef<{ key: string; payload: string } | null>(null);

  function keyFor(payload: string): string {
    if (attempt.current?.payload !== payload) {
      attempt.current = { key: crypto.randomUUID(), payload };
    }
    return attempt.current.key;
  }

  const needsPublicAcknowledgement = visibility === "public";
  const canSubmit =
    relationship !== null &&
    name.trim().length > 0 &&
    declared &&
    (!needsPublicAcknowledgement || publicAcknowledged) &&
    !sending;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!relationship || !canSubmit) {
      return;
    }

    const locations =
      country.trim() || city.trim()
        ? [
            {
              kind: placeKind,
              ...(country.trim()
                ? { country: country.trim().toUpperCase().slice(0, 2) }
                : {}),
              ...(city.trim() ? { city: city.trim() } : {}),
            },
          ]
        : undefined;

    const body = {
      relationship,
      relationshipStatementAccepted: declared,
      primaryName: { value: name.trim() },
      ...(toPartialDate(birth) ? { birthDate: toPartialDate(birth) } : {}),
      ...(toPartialDate(death) ? { deathDate: toPartialDate(death) } : {}),
      ...(locations ? { locations } : {}),
      visibility,
      searchEngineIndexable: visibility === "public" ? indexable : false,
    };

    const payload = JSON.stringify(body);
    setSending(true);
    setFieldErrors({});
    setFailure(null);

    try {
      const response = await fetch("/api/memorials", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": keyFor(payload),
        },
        body: payload,
      });

      const result = await response.json().catch(() => null);

      if (!response.ok) {
        setFieldErrors(result?.error?.fieldErrors ?? {});
        setFailure(result?.error?.code ?? "unexpected");
        return;
      }

      // 201 created, 200 replay. Both mean the memorial exists and this is
      // where it lives, so both go to the same place.
      router.push(`/${props.locale}/memorials/${result.data.slug}`);
    } catch {
      setFailure("DEPENDENCY_UNAVAILABLE");
    } finally {
      setSending(false);
    }
  }

  function errorFor(field: string): string | null {
    return fieldErrors[field]?.[0] ?? null;
  }

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      <fieldset className="fieldset stack">
        <legend className="eyebrow">{t("relationshipLabel")}</legend>
        <div className="ritualChoices">
          {RELATIONSHIPS.map((option) => (
            <button
              type="button"
              key={option}
              className={
                relationship === option
                  ? "button buttonPrimary"
                  : "button buttonQuiet"
              }
              aria-pressed={relationship === option}
              onClick={() => setRelationship(option)}
            >
              {t(
                `relationship${option.charAt(0).toUpperCase()}${option.slice(1)}`,
              )}
            </button>
          ))}
        </div>
        {errorFor("relationship") ? (
          <p className="fieldError" role="alert">
            {errorFor("relationship")}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="fieldset stack measure">
        <legend className="eyebrow">{t("nameLabel")}</legend>
        <label className="field">
          <span className="fieldLabel">
            {t("nameLabel")} <span aria-hidden="true">*</span>
          </span>
          <input
            className="input"
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {errorFor("primaryName") ? (
          <p className="fieldError" role="alert">
            {errorFor("primaryName")}
          </p>
        ) : null}
      </fieldset>

      <DateField
        legend={t("birthDateLabel")}
        precisionLabel={t("datePrecisionLabel")}
        value={birth}
        onChange={setBirth}
        labelFor={(precision) =>
          t(
            `datePrecision${precision.charAt(0).toUpperCase()}${precision.slice(1)}`,
          )
        }
      />

      <DateField
        legend={t("deathDateLabel")}
        precisionLabel={t("datePrecisionLabel")}
        value={death}
        onChange={setDeath}
        error={errorFor("deathDate")}
        labelFor={(precision) =>
          t(
            `datePrecision${precision.charAt(0).toUpperCase()}${precision.slice(1)}`,
          )
        }
      />

      <fieldset className="fieldset stack">
        <legend className="eyebrow">{t("placeLabel")}</legend>
        <div className="searchForm">
          <label className="field">
            <span className="fieldLabel">{t("placeLabel")}</span>
            <select
              className="input"
              value={placeKind}
              onChange={(event) =>
                setPlaceKind(event.target.value as PlaceKind)
              }
            >
              {PLACE_KINDS.map((kind) => (
                <option value={kind.value} key={kind.value}>
                  {t(kind.key)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="fieldLabel">{search("countryLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={2}
              placeholder="IE"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("cityLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              value={city}
              onChange={(event) => setCity(event.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fieldset stack measure">
        <legend className="eyebrow">{privacy("title")}</legend>

        {(
          [
            ["public", privacy("public"), privacy("publicHelp")],
            ["unlisted", privacy("unlisted"), privacy("unlistedHelp")],
            ["invite_only", privacy("inviteOnly"), privacy("inviteOnlyHelp")],
          ] as const
        ).map(([value, label, help]) => (
          <label className="choiceRow" key={value}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === value}
              onChange={() => setVisibility(value)}
            />
            <span>
              <strong>{label}</strong>
              <span className="muted"> — {help}</span>
            </span>
          </label>
        ))}

        {visibility === "public" ? (
          <>
            <label className="choiceRow">
              <input
                type="checkbox"
                checked={indexable}
                onChange={(event) => setIndexable(event.target.checked)}
              />
              <span>{privacy("searchEngineLabel")}</span>
            </label>

            {/*
             * Shown before the memorial exists, not after. The server defaults
             * to public and does not demand this acknowledgement on create, so
             * it is the interface's job to make sure a family understands what
             * public means while the choice is still cheap to change.
             */}
            <div className="notice stack">
              <strong>{privacy("confirmPublicTitle")}</strong>
              <p>{privacy("confirmPublicBody")}</p>
              <label className="choiceRow">
                <input
                  type="checkbox"
                  checked={publicAcknowledged}
                  onChange={(event) =>
                    setPublicAcknowledged(event.target.checked)
                  }
                />
                <span>{privacy("confirmPublicAcknowledge")}</span>
              </label>
            </div>
          </>
        ) : null}
      </fieldset>

      <fieldset className="fieldset stack measure">
        <label className="choiceRow">
          <input
            type="checkbox"
            checked={declared}
            onChange={(event) => setDeclared(event.target.checked)}
          />
          <span>{t("truthDeclaration")}</span>
        </label>
        {errorFor("relationshipStatementAccepted") ? (
          <p className="fieldError" role="alert">
            {errorFor("relationshipStatementAccepted")}
          </p>
        ) : null}
      </fieldset>

      <div className="stack">
        <div>
          <button
            className="button buttonPrimary"
            type="submit"
            disabled={!canSubmit}
          >
            {sending ? common("loading") : home("createMemorial")}
          </button>
        </div>

        {failure ? (
          <p className="fieldError" role="alert">
            {failure === "DUPLICATE_CANDIDATE_FOUND"
              ? t("duplicateWarning")
              : errors.has(failure)
                ? errors(failure)
                : errors("unexpected")}
          </p>
        ) : null}

        {errorFor("_") ? (
          <p className="fieldError" role="alert">
            {errorFor("_")}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** A date the family may only half know. */
function DateField(props: {
  legend: string;
  precisionLabel: string;
  value: PartialDateInput;
  onChange: (next: PartialDateInput) => void;
  error?: string | null;
  labelFor: (precision: Precision) => string;
}) {
  const { value, onChange } = props;

  return (
    <fieldset className="fieldset stack">
      <legend className="eyebrow">{props.legend}</legend>
      <div className="searchForm">
        <label className="field">
          <span className="fieldLabel">{props.precisionLabel}</span>
          <select
            className="input"
            value={value.precision}
            onChange={(event) =>
              // Changing precision clears the value: a "YYYY-MM" left in the
              // box after switching to a day would submit an invalid date.
              onChange({ precision: event.target.value as Precision, raw: "" })
            }
          >
            {PRECISIONS.map((precision) => (
              <option value={precision} key={precision}>
                {props.labelFor(precision)}
              </option>
            ))}
          </select>
        </label>

        {value.precision !== "unknown" ? (
          <label className="field">
            <span className="fieldLabel">{props.legend}</span>
            <input
              className="input"
              type={
                value.precision === "day"
                  ? "date"
                  : value.precision === "month"
                    ? "month"
                    : "number"
              }
              {...(value.precision === "year" || value.precision === "approximate"
                ? { min: 1583, max: 2200, placeholder: "1931" }
                : {})}
              value={value.raw}
              onChange={(event) =>
                onChange({ ...value, raw: event.target.value })
              }
            />
          </label>
        ) : null}
      </div>
      {props.error ? (
        <p className="fieldError" role="alert">
          {props.error}
        </p>
      ) : null}
    </fieldset>
  );
}
