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

/**
 * Runs a 族谱 seed from the admin panel. Idempotent, so the operator can run it
 * again safely; the result shows exactly what was created versus already there.
 * "只灌已故世代" is on by default — living people are seeded only on a deliberate
 * choice.
 */
export function GenealogySeed(props: { locale: string }) {
  const [source, setSource] = useState<"kong" | "song">("kong");
  const [skipLiving, setSkipLiving] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/admin/genealogy/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, skipLiving }),
      });
      const data = (await res.json().catch(() => null)) as
        | { data?: Report }
        | null;
      if (res.ok && data?.data) {
        setReport(data.data);
      } else {
        setError("导入失败，请查看日志。");
      }
    } catch {
      setError("导入失败，请查看日志。");
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
            onChange={(e) => setSource(e.target.value as "kong" | "song")}
          >
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
        <div>
          <button
            type="button"
            className="button buttonPrimary"
            disabled={busy}
            onClick={run}
          >
            {busy ? "导入中…" : "开始导入"}
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
    </div>
  );
}
