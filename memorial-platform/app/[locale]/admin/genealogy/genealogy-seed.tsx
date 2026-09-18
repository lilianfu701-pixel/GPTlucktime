"use client";

import { useMemo, useState } from "react";

type Report = {
  source: string;
  peopleTotal: number;
  memorialsCreated: number;
  memorialsExisting: number;
  livingCreated: number;
  livingExisting: number;
  portraitsAdded: number;
  linksCreated: number;
  linksExisting: number;
  issues: { stage: string; externalId?: string; error: string }[];
  memorials: { name: string; slug: string; created: boolean }[];
};

type RollbackReport = {
  source: string;
  memorialsDeleted: number;
  livingDeleted: number;
  skippedClaimed: number;
};

type FamilyMeta = {
  key: string;
  label: string;
  people: number;
  deceased: number;
  photos: number;
};

/** Per-family state as a batch runs, so the operator sees progress live. */
type RowState =
  | { status: "idle" }
  | { status: "running"; pass?: number }
  | { status: "done"; report: Report }
  | { status: "partial"; report: Report }
  | { status: "rolledBack"; report: RollbackReport }
  | { status: "error"; message: string };

/**
 * A big family (溥仪, 187 人 + 数十张照片) can exceed the serverless time limit
 * in a single request. The import is idempotent and each pass gets further, so
 * the batch re-runs a family until a pass finishes with nothing left to create.
 */
const MAX_SEED_PASSES = 30;

async function callSeed(
  source: string,
  action: "seed" | "rollback",
  skipLiving: boolean,
): Promise<{ ok: true; data: Report & RollbackReport } | { ok: false }> {
  try {
    const res = await fetch("/api/admin/genealogy/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, action, skipLiving }),
    });
    const data = (await res.json().catch(() => null)) as
      | { data?: Report & RollbackReport }
      | null;
    if (res.ok && data?.data) return { ok: true, data: data.data };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs 族谱 seeds from the admin panel. Idempotent, so the operator can run it
 * again safely; each row shows what was created versus already there. The batch
 * imports one family per request (staying inside the serverless time limit) and
 * loops, so a large family that times out can just be re-run to continue.
 * "只灌已故世代" is on by default — living people are seeded only on a
 * deliberate choice.
 */
export function GenealogySeed(props: {
  locale: string;
  families: FamilyMeta[];
  /** Deceased pages already seeded per family key, read from the DB on load. */
  imported: Record<string, number>;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [skipLiving, setSkipLiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [legacy, setLegacy] = useState<"kong" | "song">("kong");
  const [legacyReport, setLegacyReport] = useState<Report | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  // 未导入的排在上面、已导入的沉到底部，方便一眼找到还没灌的家族。
  // 同一状态内保持原有的策展顺序（Array.sort 稳定）。
  const sortedFamilies = useMemo(() => {
    const isDone = (f: FamilyMeta): boolean => {
      const n = props.imported[f.key] ?? 0;
      return n > 0 && n >= f.deceased;
    };
    return [...props.families].sort(
      (a, b) => (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0),
    );
  }, [props.families, props.imported]);

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runBatch(action: "seed" | "rollback"): Promise<void> {
    if (busy) return;
    const keys = sortedFamilies.map((f) => f.key).filter((k) => selected.has(k));
    if (keys.length === 0) return;
    if (
      action === "rollback" &&
      !window.confirm(
        `将回滚所选 ${keys.length} 支家族本批导入的页面与节点（已被家属认领的会保留）。确定？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setRows(Object.fromEntries(keys.map((k) => [k, { status: "idle" as const }])));
    for (const key of keys) {
      if (action === "rollback") {
        setRows((prev) => ({ ...prev, [key]: { status: "running" } }));
        const result = await callSeed(key, "rollback", skipLiving);
        setRows((prev) => ({
          ...prev,
          [key]: result.ok
            ? { status: "rolledBack", report: result.data }
            : { status: "error", message: "失败，请查看日志或重试。" },
        }));
        continue;
      }
      // Seed: re-run the family until a pass creates nothing new. A pass that
      // times out mid-way still saved its progress, so the next one continues.
      let last: Report | null = null;
      let converged = false;
      for (let pass = 1; pass <= MAX_SEED_PASSES; pass += 1) {
        setRows((prev) => ({ ...prev, [key]: { status: "running", pass } }));
        const result = await callSeed(key, "seed", skipLiving);
        if (result.ok) {
          last = result.data;
          if (result.data.memorialsCreated === 0 && result.data.portraitsAdded === 0) {
            converged = true;
            break;
          }
        }
      }
      setRows((prev) => ({
        ...prev,
        [key]: last
          ? converged
            ? { status: "done", report: last }
            : { status: "partial", report: last }
          : { status: "error", message: "超时或失败，请再点一次续灌。" },
      }));
    }
    setBusy(false);
  }

  async function runLegacy(action: "seed" | "rollback"): Promise<void> {
    if (busy) return;
    if (
      action === "rollback" &&
      !window.confirm("将删除本批导入的所有页面与节点（已被家属认领的会保留）。确定回滚？")
    ) {
      return;
    }
    setBusy(true);
    setLegacyError(null);
    setLegacyReport(null);
    const result = await callSeed(legacy, action, skipLiving);
    if (result.ok && action === "seed") setLegacyReport(result.data);
    else if (!result.ok) setLegacyError("操作失败，请查看日志。");
    setBusy(false);
  }

  const allSelected = selected.size === props.families.length;

  return (
    <div className="stack-lg">
      <section className="stack">
        <h2>名人家族批量导入（Wikidata）</h2>
        <p className="muted measure">
          含照片、生平、上下数代与旁系配偶。跨家族按 QID 全局去重，同一人只建一页。
        </p>

        <label className="avatarTreeToggle">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(props.families.map((f) => f.key)))
            }
          />
          <span>{allSelected ? "全不选" : "全选"}</span>
        </label>

        <ul className="stack">
          {sortedFamilies.map((f) => {
            const state = rows[f.key];
            return (
              <li key={f.key} className="adminHeadRow" style={{ alignItems: "center", gap: "0.75rem" }}>
                <label className="avatarTreeToggle" style={{ flex: "1 1 auto" }}>
                  <input
                    type="checkbox"
                    checked={selected.has(f.key)}
                    disabled={busy}
                    onChange={() => toggle(f.key)}
                  />
                  <span>
                    {f.label}
                    <span className="muted">
                      {" "}
                      · {f.people} 人 · {f.photos} 照片
                    </span>
                  </span>
                </label>
                <RowStatus
                  state={state}
                  importedCount={props.imported[f.key] ?? 0}
                  deceased={f.deceased}
                />
              </li>
            );
          })}
        </ul>

        <label className="avatarTreeToggle">
          <input
            type="checkbox"
            checked={skipLiving}
            onChange={(e) => setSkipLiving(e.target.checked)}
          />
          <span>只灌已故世代（勾选后跳过在世者，不建其页面）</span>
        </label>

        <div className="adminHeadRow">
          <button
            type="button"
            className="button buttonPrimary"
            disabled={busy || selected.size === 0}
            onClick={() => runBatch("seed")}
          >
            {busy ? "处理中…" : `批量导入所选（${selected.size} 支）`}
          </button>
          <button
            type="button"
            className="button buttonQuiet"
            disabled={busy || selected.size === 0}
            onClick={() => runBatch("rollback")}
          >
            回滚所选
          </button>
        </div>
      </section>

      <section className="stack">
        <h2>单批导入（示例 / 公有领域）</h2>
        <label className="field">
          <span className="fieldLabel">数据源</span>
          <select
            className="input"
            value={legacy}
            onChange={(e) => setLegacy(e.target.value as "kong" | "song")}
          >
            <option value="kong">孔子世系（衍圣公直系，公有领域）</option>
            <option value="song">三苏世家（示例）</option>
          </select>
        </label>
        <div className="adminHeadRow">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => runLegacy("seed")}
          >
            开始导入
          </button>
          <button
            type="button"
            className="button buttonQuiet"
            disabled={busy}
            onClick={() => runLegacy("rollback")}
          >
            回滚本批
          </button>
        </div>
        {legacyError ? (
          <p className="fieldError" role="alert">
            {legacyError}
          </p>
        ) : null}
        {legacyReport ? (
          <div className="notice stack" role="status">
            <strong>导入完成（{legacyReport.source}）</strong>
            <ul className="stack">
              <li>
                追思页：新建 {legacyReport.memorialsCreated} · 已存在{" "}
                {legacyReport.memorialsExisting}
              </li>
              <li>遗照：{legacyReport.portraitsAdded} 张</li>
              <li>问题：{legacyReport.issues.length}</li>
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function RowStatus(props: {
  state: RowState | undefined;
  importedCount: number;
  deceased: number;
}) {
  const state = props.state;
  // No live run this session: fall back to the real DB baseline, so a reloaded
  // page shows what is already seeded instead of a blank 待导入.
  if (!state || state.status === "idle") {
    if (props.importedCount === 0) return <span className="muted">待导入</span>;
    if (props.importedCount >= props.deceased)
      return (
        <span className="muted">
          ✓ 已导入 {props.importedCount}/{props.deceased}
        </span>
      );
    return (
      <span className="fieldError">
        部分导入 {props.importedCount}/{props.deceased}，请再点一次续灌
      </span>
    );
  }
  if (state.status === "running")
    return (
      <span className="muted">
        导入中…{state.pass && state.pass > 1 ? `（第 ${state.pass} 轮续灌）` : ""}
      </span>
    );
  if (state.status === "error")
    return (
      <span className="fieldError" role="alert">
        {state.message}
      </span>
    );
  if (state.status === "rolledBack") {
    const r = state.report;
    return (
      <span className="muted">
        已回滚 {r.memorialsDeleted} 页 · 保留认领 {r.skippedClaimed}
      </span>
    );
  }
  if (state.status === "partial") {
    const r = state.report;
    return (
      <span className="fieldError">
        未灌完（＝{r.memorialsExisting}），请再点一次「批量导入所选」续灌
      </span>
    );
  }
  const r = state.report;
  return (
    <span className="muted">
      ✓ ＋{r.memorialsCreated} ／ ＝{r.memorialsExisting} · 遗照 {r.portraitsAdded}
      {r.issues.length > 0 ? ` · 问题 ${r.issues.length}` : ""}
    </span>
  );
}
