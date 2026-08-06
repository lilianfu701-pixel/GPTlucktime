"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Relationship =
  | "husband"
  | "wife"
  | "father"
  | "mother"
  | "son"
  | "daughter"
  | "older_sister"
  | "older_brother"
  | "younger_brother"
  | "younger_sister";

type Precision = "unknown" | "year" | "approximate" | "month" | "day";
type Visibility = "public" | "unlisted" | "invite_only";
type NameType = "former" | "native" | "transliteration" | "alias";

type PartialDateInput = { precision: Precision; raw: string };

type AliasEntry = { value: string; type: NameType };

type RelativeEntry = {
  name: string;
  relationshipToDeceased: string;
  isDeceased: boolean;
  showFullName: boolean;
};

const RELATIONSHIPS: Relationship[] = [
  "husband",
  "wife",
  "father",
  "mother",
  "son",
  "daughter",
];

const PRECISIONS: Precision[] = [
  "day",
  "month",
  "year",
  "approximate",
  "unknown",
];

const NAME_TYPES: NameType[] = ["alias", "former", "native", "transliteration"];

const RELATIVE_RELATIONSHIPS = [
  "father",
  "mother",
  "paternal_grandfather",
  "paternal_grandmother",
  "maternal_grandfather",
  "maternal_grandmother",
  "husband",
  "wife",
  "ex_husband",
  "ex_wife",
  "son",
  "daughter",
  "older_brother",
  "older_sister",
  "younger_brother",
  "younger_sister",
] as const;

const MAX_ONE: ReadonlySet<string> = new Set([
  "father",
  "mother",
  "paternal_grandfather",
  "paternal_grandmother",
  "maternal_grandfather",
  "maternal_grandmother",
  "husband",
  "wife",
]);

const EMPTY_DATE: PartialDateInput = { precision: "unknown", raw: "" };

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
    return { value: `${input.raw}-01`, precision: "month" };
  }
  const year = input.raw.padStart(4, "0").slice(0, 4);
  return { value: `${year}-01-01`, precision: input.precision };
}

function desensitizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed;
  const chars = [...trimmed];
  if (chars.length === 2) return chars[0] + "*";
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

export function CreateMemorialForm(props: { locale: string }) {
  const t = useTranslations("memorial");
  const privacy = useTranslations("privacy");
  const errors = useTranslations("errors");
  const common = useTranslations("common");
  const home = useTranslations("home");
  const router = useRouter();

  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState<AliasEntry[]>([]);
  const [birth, setBirth] = useState<PartialDateInput>(EMPTY_DATE);
  const [death, setDeath] = useState<PartialDateInput>(EMPTY_DATE);

  const [birthCountry, setBirthCountry] = useState("");
  const [birthRegion, setBirthRegion] = useState("");
  const [birthCity, setBirthCity] = useState("");

  const [deathCountry, setDeathCountry] = useState("");
  const [deathRegion, setDeathRegion] = useState("");
  const [deathCity, setDeathCity] = useState("");

  const [ancestralHometown, setAncestralHometown] = useState("");
  const [faith, setFaith] = useState("");
  const [causeOfDeath, setCauseOfDeath] = useState("");

  const [relatives, setRelatives] = useState<RelativeEntry[]>([]);
  const [showAllNames, setShowAllNames] = useState(false);

  const [visibility, setVisibility] = useState<Visibility>("public");
  const [indexable, setIndexable] = useState(true);
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [coCreate, setCoCreate] = useState(false);
  const [coCreatorEmails, setCoCreatorEmails] = useState<string[]>([]);

  const [declared, setDeclared] = useState(false);

  const [sending, setSending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);

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

  function addAlias(): void {
    setAliases([...aliases, { value: "", type: "alias" }]);
  }

  function updateAlias(idx: number, patch: Partial<AliasEntry>): void {
    setAliases(aliases.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  function removeAlias(idx: number): void {
    setAliases(aliases.filter((_, i) => i !== idx));
  }

  function addCoCreator(): void {
    setCoCreatorEmails([...coCreatorEmails, ""]);
  }

  function updateCoCreator(idx: number, value: string): void {
    setCoCreatorEmails(coCreatorEmails.map((e, i) => (i === idx ? value : e)));
  }

  function removeCoCreator(idx: number): void {
    setCoCreatorEmails(coCreatorEmails.filter((_, i) => i !== idx));
  }

  function relativeUsedCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of relatives) {
      counts.set(
        r.relationshipToDeceased,
        (counts.get(r.relationshipToDeceased) ?? 0) + 1,
      );
    }
    return counts;
  }

  function isRelMaxedOut(rel: string, counts: Map<string, number>): boolean {
    return MAX_ONE.has(rel) && (counts.get(rel) ?? 0) >= 1;
  }

  function firstAvailableRelationship(): string {
    const counts = relativeUsedCounts();
    for (const rr of RELATIVE_RELATIONSHIPS) {
      if (!isRelMaxedOut(rr, counts)) return rr;
    }
    return RELATIVE_RELATIONSHIPS[0];
  }

  function addRelative(): void {
    setRelatives([
      ...relatives,
      {
        name: "",
        relationshipToDeceased: firstAvailableRelationship(),
        isDeceased: false,
        showFullName: false,
      },
    ]);
  }

  function updateRelative(idx: number, patch: Partial<RelativeEntry>): void {
    setRelatives(
      relatives.map((r, i) => {
        if (i !== idx) return r;
        const updated = { ...r, ...patch };
        if ("isDeceased" in patch) {
          updated.showFullName = patch.isDeceased ?? false;
        }
        return updated;
      }),
    );
  }

  function removeRelative(idx: number): void {
    setRelatives(relatives.filter((_, i) => i !== idx));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!relationship || !canSubmit) return;

    const locations: {
      kind: "birth" | "death";
      country?: string;
      region?: string;
      city?: string;
    }[] = [];

    if (birthCountry.trim() || birthRegion.trim() || birthCity.trim()) {
      locations.push({
        kind: "birth",
        ...(birthCountry.trim()
          ? { country: birthCountry.trim().toUpperCase().slice(0, 2) }
          : {}),
        ...(birthRegion.trim() ? { region: birthRegion.trim() } : {}),
        ...(birthCity.trim() ? { city: birthCity.trim() } : {}),
      });
    }

    if (deathCountry.trim() || deathRegion.trim() || deathCity.trim()) {
      locations.push({
        kind: "death",
        ...(deathCountry.trim()
          ? { country: deathCountry.trim().toUpperCase().slice(0, 2) }
          : {}),
        ...(deathRegion.trim() ? { region: deathRegion.trim() } : {}),
        ...(deathCity.trim() ? { city: deathCity.trim() } : {}),
      });
    }

    const validAliases = aliases
      .filter((a) => a.value.trim().length > 0)
      .map((a) => ({ value: a.value.trim(), type: a.type }));

    const validRelatives = relatives
      .filter((r) => r.name.trim().length > 0)
      .map((r) => ({
        name: r.name.trim(),
        relationshipToDeceased: r.relationshipToDeceased,
        isDeceased: r.isDeceased,
        showFullName: showAllNames || r.showFullName,
      }));

    const body = {
      relationship,
      relationshipStatementAccepted: declared,
      primaryName: { value: name.trim() },
      ...(validAliases.length > 0 ? { aliases: validAliases } : {}),
      ...(toPartialDate(birth) ? { birthDate: toPartialDate(birth) } : {}),
      ...(toPartialDate(death) ? { deathDate: toPartialDate(death) } : {}),
      ...(locations.length > 0 ? { locations } : {}),
      ...(ancestralHometown.trim()
        ? { ancestralHometown: ancestralHometown.trim() }
        : {}),
      ...(faith.trim() ? { faith: faith.trim() } : {}),
      ...(causeOfDeath.trim() ? { causeOfDeath: causeOfDeath.trim() } : {}),
      ...(validRelatives.length > 0 ? { relatives: validRelatives } : {}),
      ...(coCreate && coCreatorEmails.filter((e) => e.trim()).length > 0
        ? { coCreatorEmails: coCreatorEmails.filter((e) => e.trim()).map((e) => e.trim()) }
        : {}),
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
    <form className="createForm" onSubmit={submit} noValidate>
      {/* ── Relationship ── */}
      <fieldset className="formSection">
        <legend className="eyebrow">{t("relationshipPrompt")}</legend>
        <div className="relationshipGrid">
          {RELATIONSHIPS.map((option) => (
            <button
              type="button"
              key={option}
              className={
                relationship === option
                  ? "button buttonPrimary buttonCompact"
                  : "button buttonQuiet buttonCompact"
              }
              aria-pressed={relationship === option}
              onClick={() => setRelationship(option)}
            >
              {t(`relationship_${option}`)}
            </button>
          ))}
        </div>
        {errorFor("relationship") ? (
          <p className="fieldError" role="alert">
            {errorFor("relationship")}
          </p>
        ) : null}
      </fieldset>

      {/* ── Name ── */}
      <fieldset className="formSection measure">
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
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {errorFor("primaryName") ? (
          <p className="fieldError" role="alert">
            {errorFor("primaryName")}
          </p>
        ) : null}

        {aliases.map((alias, i) => (
          <div className="aliasRow" key={i}>
            <label className="field aliasName">
              <span className="fieldLabel">{t("aliasNameLabel")}</span>
              <input
                className="input"
                type="text"
                maxLength={200}
                value={alias.value}
                onChange={(e) => updateAlias(i, { value: e.target.value })}
              />
            </label>
            <label className="field aliasType">
              <span className="fieldLabel">{t("aliasTypeLabel")}</span>
              <select
                className="input"
                value={alias.type}
                onChange={(e) =>
                  updateAlias(i, { type: e.target.value as NameType })
                }
              >
                {NAME_TYPES.map((nt) => (
                  <option value={nt} key={nt}>
                    {t(`nameType_${nt}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button buttonQuiet buttonCompact aliasRemove"
              onClick={() => removeAlias(i)}
              aria-label={common("remove")}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="linkButton" onClick={addAlias}>
          + {t("addAlias")}
        </button>
      </fieldset>

      {/* ── Birth info ── */}
      <fieldset className="formSection">
        <legend className="eyebrow">{t("birthInfoLabel")}</legend>
        <div className="dateRow">
          <label className="field">
            <span className="fieldLabel">{t("datePrecisionLabel")}</span>
            <select
              className="input"
              value={birth.precision}
              onChange={(e) =>
                setBirth({ precision: e.target.value as Precision, raw: "" })
              }
            >
              {PRECISIONS.map((p) => (
                <option value={p} key={p}>
                  {t(
                    `datePrecision${p.charAt(0).toUpperCase()}${p.slice(1)}`,
                  )}
                </option>
              ))}
            </select>
          </label>
          {birth.precision !== "unknown" ? (
            <label className="field">
              <span className="fieldLabel">{t("birthDateLabel")}</span>
              <input
                className="input"
                type={
                  birth.precision === "day"
                    ? "date"
                    : birth.precision === "month"
                      ? "month"
                      : "number"
                }
                {...(birth.precision === "year" ||
                birth.precision === "approximate"
                  ? { min: 1583, max: 2200, placeholder: "1931" }
                  : {})}
                value={birth.raw}
                onChange={(e) => setBirth({ ...birth, raw: e.target.value })}
              />
            </label>
          ) : null}
        </div>
        <div className="placeRow">
          <label className="field">
            <span className="fieldLabel">{t("countryLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={2}
              placeholder="CN"
              value={birthCountry}
              onChange={(e) => setBirthCountry(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("regionLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              value={birthRegion}
              onChange={(e) => setBirthRegion(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("cityLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              value={birthCity}
              onChange={(e) => setBirthCity(e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      {/* ── Death info ── */}
      <fieldset className="formSection">
        <legend className="eyebrow">{t("deathInfoLabel")}</legend>
        <div className="dateRow">
          <label className="field">
            <span className="fieldLabel">{t("datePrecisionLabel")}</span>
            <select
              className="input"
              value={death.precision}
              onChange={(e) =>
                setDeath({ precision: e.target.value as Precision, raw: "" })
              }
            >
              {PRECISIONS.map((p) => (
                <option value={p} key={p}>
                  {t(
                    `datePrecision${p.charAt(0).toUpperCase()}${p.slice(1)}`,
                  )}
                </option>
              ))}
            </select>
          </label>
          {death.precision !== "unknown" ? (
            <label className="field">
              <span className="fieldLabel">{t("deathDateLabel")}</span>
              <input
                className="input"
                type={
                  death.precision === "day"
                    ? "date"
                    : death.precision === "month"
                      ? "month"
                      : "number"
                }
                {...(death.precision === "year" ||
                death.precision === "approximate"
                  ? { min: 1583, max: 2200, placeholder: "2024" }
                  : {})}
                value={death.raw}
                onChange={(e) => setDeath({ ...death, raw: e.target.value })}
              />
            </label>
          ) : null}
        </div>
        {errorFor("deathDate") ? (
          <p className="fieldError" role="alert">
            {errorFor("deathDate")}
          </p>
        ) : null}
        <div className="placeRow">
          <label className="field">
            <span className="fieldLabel">{t("countryLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={2}
              placeholder="CN"
              value={deathCountry}
              onChange={(e) => setDeathCountry(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("regionLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              value={deathRegion}
              onChange={(e) => setDeathRegion(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="fieldLabel">{t("cityLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              value={deathCity}
              onChange={(e) => setDeathCity(e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      {/* ── Personal info ── */}
      <fieldset className="formSection measure">
        <legend className="eyebrow">{t("personalInfoLabel")}</legend>
        <label className="field">
          <span className="fieldLabel">{t("ancestralHometownLabel")}</span>
          <input
            className="input"
            type="text"
            maxLength={200}
            value={ancestralHometown}
            onChange={(e) => setAncestralHometown(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="fieldLabel">{t("faithLabel")}</span>
          <input
            className="input"
            type="text"
            maxLength={200}
            value={faith}
            onChange={(e) => setFaith(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="fieldLabel">{t("causeOfDeathLabel")}</span>
          <input
            className="input"
            type="text"
            maxLength={500}
            value={causeOfDeath}
            onChange={(e) => setCauseOfDeath(e.target.value)}
          />
        </label>
      </fieldset>

      {/* ── Family members ── */}
      <fieldset className="formSection">
        <legend className="eyebrow">{t("relativesLabel")}</legend>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {t("relativesHelp")}
        </p>

        {relatives.map((rel, i) => {
          const counts = relativeUsedCounts();
          return (
          <div className="relativeRow" key={i}>
            <label className="field relativeName">
              <span className="fieldLabel">{t("relativeNameLabel")}</span>
              <input
                className="input"
                type="text"
                maxLength={200}
                value={rel.name}
                onChange={(e) =>
                  updateRelative(i, { name: e.target.value })
                }
              />
            </label>
            <label className="field relativeRelation">
              <span className="fieldLabel">{t("relativeRelationLabel")}</span>
              <select
                className="input"
                value={rel.relationshipToDeceased}
                onChange={(e) =>
                  updateRelative(i, {
                    relationshipToDeceased: e.target.value,
                  })
                }
              >
                {RELATIVE_RELATIONSHIPS.map((rr) => (
                  <option
                    value={rr}
                    key={rr}
                    disabled={
                      rr !== rel.relationshipToDeceased &&
                      isRelMaxedOut(rr, counts)
                    }
                  >
                    {t(`relativeRole_${rr}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field relativeStatus">
              <span className="fieldLabel">{t("relativeStatusLabel")}</span>
              <select
                className="input"
                value={rel.isDeceased ? "deceased" : "living"}
                onChange={(e) =>
                  updateRelative(i, {
                    isDeceased: e.target.value === "deceased",
                  })
                }
              >
                <option value="living">{t("statusLiving")}</option>
                <option value="deceased">{t("statusDeceased")}</option>
              </select>
            </label>
            <div className="relativePreview">
              <span className="fieldLabel">{t("displayPreview")}</span>
              <span className="relativePreviewName">
                {showAllNames || rel.showFullName
                  ? rel.name || "—"
                  : rel.name
                    ? desensitizeName(rel.name)
                    : "—"}
              </span>
            </div>
            <button
              type="button"
              className="button buttonQuiet buttonCompact aliasRemove"
              onClick={() => removeRelative(i)}
              aria-label={common("remove")}
            >
              ×
            </button>
          </div>
          );
        })}

        <div className="relativesActions">
          <button type="button" className="linkButton" onClick={addRelative}>
            + {t("addRelative")}
          </button>
          {relatives.length > 0 ? (
            <label className="choiceRow">
              <input
                type="checkbox"
                checked={showAllNames}
                onChange={(e) => setShowAllNames(e.target.checked)}
              />
              <span>{t("showAllNames")}</span>
            </label>
          ) : null}
        </div>
      </fieldset>

      {/* ── Co-create ── */}
      <fieldset className="formSection measure">
        <legend className="eyebrow">{t("coCreateLabel")}</legend>
        <label className="choiceRow">
          <input
            type="checkbox"
            checked={coCreate}
            onChange={(e) => {
              setCoCreate(e.target.checked);
              if (!e.target.checked) setCoCreatorEmails([]);
            }}
          />
          <span>{t("coCreateToggle")}</span>
        </label>
        {coCreate ? (
          <>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {t("coCreateHelp")}
            </p>
            {coCreatorEmails.map((email, i) => (
              <div className="aliasRow" key={i}>
                <label className="field aliasName">
                  <span className="fieldLabel">{t("coCreatorEmailLabel")}</span>
                  <input
                    className="input"
                    type="email"
                    maxLength={320}
                    placeholder="relative@example.com"
                    value={email}
                    onChange={(e) => updateCoCreator(i, e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="button buttonQuiet buttonCompact aliasRemove"
                  onClick={() => removeCoCreator(i)}
                  aria-label={common("remove")}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="linkButton" onClick={addCoCreator}>
              + {t("addCoCreator")}
            </button>
          </>
        ) : null}
      </fieldset>

      {/* ── Privacy ── */}
      <fieldset className="formSection measure">
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
                onChange={(e) => setIndexable(e.target.checked)}
              />
              <span>{privacy("searchEngineLabel")}</span>
            </label>
            <div className="notice stack">
              <strong>{privacy("confirmPublicTitle")}</strong>
              <p>{privacy("confirmPublicBody")}</p>
              <label className="choiceRow">
                <input
                  type="checkbox"
                  checked={publicAcknowledged}
                  onChange={(e) => setPublicAcknowledged(e.target.checked)}
                />
                <span>{privacy("confirmPublicAcknowledge")}</span>
              </label>
            </div>
          </>
        ) : null}
      </fieldset>

      {/* ── Declaration ── */}
      <fieldset className="formSection measure">
        <label className="choiceRow">
          <input
            type="checkbox"
            checked={declared}
            onChange={(e) => setDeclared(e.target.checked)}
          />
          <span>{t("truthDeclaration")}</span>
        </label>
        {errorFor("relationshipStatementAccepted") ? (
          <p className="fieldError" role="alert">
            {errorFor("relationshipStatementAccepted")}
          </p>
        ) : null}
      </fieldset>

      {/* ── Submit ── */}
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
