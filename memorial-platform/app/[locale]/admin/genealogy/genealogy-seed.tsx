"use client";

import { useState } from "react";

type Report = {
  source: string;
  peopleTotal: number;
  memorialsCreated: number;
  memorialsExisting: number;
  livingCreated: number;
  livingExisting: number;
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

/**
 * Runs a 族谱 seed from the admin panel. Idempotent, so the operator can run it
 * again safely; the result shows exactly what was created versus already there.
 * "只灌已故世代" is on by default — living people are seeded only on a deliberate
 * choice.
 */
export function GenealogySeed(props: { locale: string }) {
  const [source, setSource] = useState<"kong" | "song" | "soong">("soong");
  const [skipLiving, setSkipLiving] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [rollback, setRollback] = useState<RollbackReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "seed" | "rollback"): Promise<void> {
    if (busy) return;
    if (
      action === "rollback" &&
      !window.confirm("将删除本批导入的所有页面与节点（已被家属认领的会保留）。确定回滚？")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    setRollback(null);
    try {
      const res = await fetch("/api/admin/genealogy/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, action, skipLiving }),
      });
      const data = (await res.json().catch(() => null)) as
        | { data?: Report & RollbackReport }
        | null;
      if (res.ok && data?.data) {
        if (action === "rollback") setRollback(data.data as RollbackReport);
        else setReport(data.data as Report);
      } else {
        setError(action === "rollback" ? "回滚失败，请查看日志。" : "导入失败，请查看日志。");
      }
    } catch {
      setError(action === "rollback" ? "回滚失败，请查看日志。" : "导入失败，请查看日志。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="stack">
        <label className="field">
          <span className="fieldLabel">数据源</span>
          <select
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value as "kong" | "song" | "soong")}
          >
            <option value="soong">宋氏家族（Wikidata，含照片/生平/旁系/配偶）</option>
            <option value="kong">孔子世系（衍圣公直系，公有领域）</option>
            <option value="song">三苏世家（示例）</option>
          </select>
        </label>
        <label className="avatarTreeToggle">
          <input
            type="checkbox"
            checked={skipLiving}
            onChange={(e) => setSkipLiving(e.target.checked)}
          />
          <span>只灌已故世代（跳过在世者，推荐首次勾选）</span>
        </label>
        <div className="adminHeadRow">
          <button
            type="button"
            className="button buttonPrimary"
            disabled={busy}
            onClick={() => run("seed")}
          >
            {busy ? "处理中…" : "开始导入"}
          </button>
          <button
            type="button"
            className="button buttonQuiet"
            disabled={busy}
            onClick={() => run("rollback")}
          >
            回滚本批
          </button>
        </div>
        {error ? (
          <p className="fieldError" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {report ? (
        <div className="notice stack" role="status">
          <strong>导入完成（{report.source}）</strong>
          <ul className="stack">
            <li>
              追思页：新建 {report.memorialsCreated} · 已存在{" "}
              {report.memorialsExisting}
            </li>
            <li>
              在世脱敏节点：新建 {report.livingCreated} · 已存在{" "}
              {report.livingExisting}
            </li>
            <li>
              族谱连线：新建 {report.linksCreated} · 已存在 {report.linksExisting}
            </li>
            <li>问题：{report.issues.length}</li>
          </ul>
          {report.memorials.length > 0 ? (
            <ul className="stack">
              {report.memorials.map((m) => (
                <li key={m.slug}>
                  {m.created ? "＋" : "＝"}{" "}
                  <a href={`/${props.locale}/memorials/${m.slug}`}>{m.name}</a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {rollback ? (
        <div className="notice stack" role="status">
          <strong>回滚完成（{rollback.source}）</strong>
          <ul className="stack">
            <li>删除追思页：{rollback.memorialsDeleted}</li>
            <li>删除在世脱敏节点：{rollback.livingDeleted}</li>
            <li>已被认领而保留：{rollback.skippedClaimed}</li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
