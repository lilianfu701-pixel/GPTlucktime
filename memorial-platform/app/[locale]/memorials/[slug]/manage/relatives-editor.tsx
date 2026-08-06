"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

type RelativeEntry = {
  name: string;
  relationshipToDeceased: string;
  isDeceased: boolean;
  showFullName: boolean;
};

type Notice =
  | { kind: "none" }
  | { kind: "saved" }
  | { kind: "error"; code: string };

const RELATIVE_RELATIONSHIPS = [
  "father",
  "mother",
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
  "husband",
  "wife",
]);

function desensitizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed;
  const chars = [...trimmed];
  if (chars.length === 2) return chars[0] + "*";
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

export function RelativesEditor(props: {
  memorialId: string;
  initial: RelativeEntry[];
}) {
  const t = useTranslations("memorial");
  const errors = useTranslations("errors");
  const common = useTranslations("common");

  const [relatives, setRelatives] = useState<RelativeEntry[]>(props.initial);
  const [showAllNames, setShowAllNames] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });

  function usedCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of relatives) {
      counts.set(
        r.relationshipToDeceased,
        (counts.get(r.relationshipToDeceased) ?? 0) + 1,
      );
    }
    return counts;
  }

  function isMaxedOut(rel: string, counts: Map<string, number>): boolean {
    return MAX_ONE.has(rel) && (counts.get(rel) ?? 0) >= 1;
  }

  function firstAvailableRelationship(): string {
    const counts = usedCounts();
    for (const rr of RELATIVE_RELATIONSHIPS) {
      if (!isMaxedOut(rr, counts)) return rr;
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

  async function save(): Promise<void> {
    setSaving(true);
    setNotice({ kind: "none" });

    const validRelatives = relatives
      .filter((r) => r.name.trim().length > 0)
      .map((r) => ({
        name: r.name.trim(),
        relationshipToDeceased: r.relationshipToDeceased,
        isDeceased: r.isDeceased,
        showFullName: showAllNames || r.showFullName,
      }));

    try {
      const response = await fetch(
        `/api/memorials/${props.memorialId}/relatives`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ relatives: validRelatives }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        setNotice({
          kind: "error",
          code: payload?.error?.code ?? "unexpected",
        });
        return;
      }

      setNotice({ kind: "saved" });
    } catch {
      setNotice({ kind: "error", code: "DEPENDENCY_UNAVAILABLE" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stack measure">
      <h2>{t("relativesLabel")}</h2>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {t("relativesHelp")}
      </p>

      {notice.kind === "saved" ? (
        <p className="notice">{t("relativesSaved")}</p>
      ) : null}
      {notice.kind === "error" ? (
        <p className="fieldError" role="alert">
          {errors.has(notice.code) ? errors(notice.code) : errors("unexpected")}
        </p>
      ) : null}

      {relatives.map((rel, i) => {
        const counts = usedCounts();
        return (
        <div className="relativeRow" key={i}>
          <label className="field relativeName">
            <span className="fieldLabel">{t("relativeNameLabel")}</span>
            <input
              className="input"
              type="text"
              maxLength={200}
              value={rel.name}
              onChange={(e) => updateRelative(i, { name: e.target.value })}
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
                    isMaxedOut(rr, counts)
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

      <div>
        <button
          type="button"
          className="button buttonPrimary"
          disabled={saving}
          onClick={save}
        >
          {saving ? common("loading") : t("saveRelatives")}
        </button>
      </div>
    </section>
  );
}
