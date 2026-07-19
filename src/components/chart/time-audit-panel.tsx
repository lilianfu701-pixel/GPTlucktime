import type { ChartViewModel } from "../../lib/chart-view-model";
import styles from "./chart-workbench.module.css";

type Audit = ChartViewModel["timeAudit"];
type JsonRecord = Audit["solarTerms"]["current"];

function textValue(item: JsonRecord, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value : "";
}

function numberValue(item: JsonRecord, key: string): number | null {
  const value = item[key];
  return typeof value === "number" ? value : null;
}

function machineValue(value: ChartViewModel["timeAudit"]["items"][number]["value"]): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function TimeAuditPanel({ audit }: Readonly<{ audit: Audit }>) {
  const trueSolar = audit.items.find((item) => item.id === "true-solar");
  const regularItems = audit.items.filter((item) => item.id !== "true-solar");
  const terms = [audit.solarTerms.previous, audit.solarTerms.current, audit.solarTerms.next];
  const boundaries = [audit.pillarBoundaries.year, audit.pillarBoundaries.month];

  return (
    <section className={styles.auditPanel} aria-labelledby="audit-heading">
      <div className={styles.auditHeading}>
        <div>
          <p className={styles.eyebrow}>时间溯源</p>
          <h2 id="audit-heading">时间核验</h2>
        </div>
        {trueSolar ? (
          <div className={styles.trueSolarCallout}>
            <span>{trueSolar.label}</span>
            <strong>{trueSolar.displayValue}</strong>
          </div>
        ) : null}
      </div>

      <dl className={styles.auditGrid}>
        {regularItems.map((item) => {
          const raw = machineValue(item.value);
          return (
            <div key={item.id}>
              <dt>{item.label}</dt>
              <dd>{item.displayValue}</dd>
              {raw === item.displayValue ? null : <code>机器值 {raw}</code>}
            </div>
          );
        })}
      </dl>

      <div className={styles.auditSections}>
        <section aria-labelledby="terms-heading">
          <h3 id="terms-heading">节气定位</h3>
          <ul>
            {terms.map((term) => (
              <li key={`${textValue(term, "label")}.${textValue(term, "utcIso")}`}>
                <span>{textValue(term, "label")}</span>
                <strong>{textValue(term, "termLabel")}</strong>
                <code>{textValue(term, "utcIso")}</code>
                <code>
                  历年 {numberValue(term, "calendarYear")} · 目标黄经 {numberValue(term, "targetLongitude")}°
                </code>
                <code>{textValue(term, "algorithmVersion")}</code>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="boundaries-heading">
          <h3 id="boundaries-heading">四柱边界</h3>
          <ul>
            {boundaries.map((boundary) => (
              <li key={textValue(boundary, "label")}>
                <span>{textValue(boundary, "label")}</span>
                <strong>{textValue(boundary, "termLabel")}</strong>
                <code>{textValue(boundary, "utcIso")}</code>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="warnings-heading">
          <h3 id="warnings-heading">不确定性提示</h3>
          {audit.warnings.length === 0 ? (
            <p>当前输入未触发边界不确定性提示。</p>
          ) : (
            <ul>
              {audit.warnings.map((warning) => (
                <li key={textValue(warning, "code")}>
                  <span>{textValue(warning, "displayValue")}</span>
                  <code>{JSON.stringify(warning)}</code>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="versions-heading">
          <h3 id="versions-heading">规则与算法版本</h3>
          <ul>
            {audit.versions.map((version) => (
              <li key={version.key}>
                <span>{version.label}</span>
                <code>{version.value}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.provenance} aria-labelledby="provenance-heading">
          <h3 id="provenance-heading">脱敏推导链</h3>
          <ol>
            {audit.provenance.map((trace) => (
              <li key={trace.id}>
                <strong>{trace.id}</strong>
                <code>{trace.ruleId}</code>
                <span>{trace.versionKey} · {trace.versionValue}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}
