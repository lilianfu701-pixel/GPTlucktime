import type { ChartViewGroup, ChartViewModel } from "../../lib/chart-view-model";
import styles from "./chart-workbench.module.css";

type GroupItem = ChartViewGroup["items"][number];

function textValue(item: GroupItem, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value : "";
}

function numberValue(item: GroupItem, key: string): number | null {
  const value = item[key];
  return typeof value === "number" ? value : null;
}

function stringList(item: GroupItem, key: string): readonly string[] {
  const value = item[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function TenGodItems({ group }: Readonly<{ group: ChartViewGroup }>) {
  return (
    <ul className={styles.factList}>
      {group.items.map((item) => (
        <li key={textValue(item, "id")}>
          <span>{textValue(item, "pillarLabel")} · {textValue(item, "sourceLabel")}</span>
          <strong>{textValue(item, "stem")} · {textValue(item, "tenGod")}</strong>
        </li>
      ))}
    </ul>
  );
}

function ElementItems({ group }: Readonly<{ group: ChartViewGroup }>) {
  return (
    <div className={styles.elementMatrix}>
      {group.items.map((item) => (
        <div key={textValue(item, "id")}>
          <span>{textValue(item, "sourceLabel")} · {textValue(item, "elementLabel")}</span>
          <strong>{numberValue(item, "count")}</strong>
        </div>
      ))}
    </div>
  );
}

function BasicItems({ group }: Readonly<{ group: ChartViewGroup }>) {
  return (
    <ul className={styles.basicList}>
      {group.items.map((item) => {
        const id = textValue(item, "id");
        if (id === "month-command") {
          return (
            <li key={id}>
              <strong>{textValue(item, "label")}</strong>
              <span>{textValue(item, "displayValue")} · {textValue(item, "boundaryTermLabel")}</span>
            </li>
          );
        }
        return (
          <li key={id}>
            <strong>{textValue(item, "label")} · {textValue(item, "displayValue")}</strong>
            <span>序号 {numberValue(item, "index")} · 纳音 {textValue(item, "nayin")}</span>
            <span>旬空 {stringList(item, "xunKong").join("、")} · 十二长生 {textValue(item, "twelveLifeStage")}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RelationItems({ group }: Readonly<{ group: ChartViewGroup }>) {
  if (group.items.length === 0) return <p className={styles.emptyFact}>当前四柱无已启用关系记录。</p>;
  return (
    <ul className={styles.factList}>
      {group.items.map((item) => (
        <li key={textValue(item, "id")}>
          <span>{textValue(item, "type")} · {stringList(item, "participants").join("、")}</span>
          <strong>{stringList(item, "pillarLabels").join("、")}</strong>
          <code>{textValue(item, "ruleId")}</code>
        </li>
      ))}
    </ul>
  );
}

function KyuseiItems({ group }: Readonly<{ group: ChartViewGroup }>) {
  return (
    <div className={styles.kyuseiList}>
      {group.items.map((item) => (
        <div key={textValue(item, "id")}>
          <span>{textValue(item, "label")}</span>
          <strong>{textValue(item, "name")}</strong>
          <code>{textValue(item, "ruleId")}</code>
        </div>
      ))}
      <span className={styles.disabledTag} aria-disabled="true">动态九星（即将推出）</span>
    </div>
  );
}

function GroupContent({ group }: Readonly<{ group: ChartViewGroup }>) {
  if (group.status === "unavailable") {
    return <p className={styles.unavailable}>{group.message}</p>;
  }
  if (group.id === "ten-gods") return <TenGodItems group={group} />;
  if (group.id === "elements") return <ElementItems group={group} />;
  if (group.id === "basics") return <BasicItems group={group} />;
  if (group.id === "relations") return <RelationItems group={group} />;
  if (group.id === "kyusei") return <KyuseiItems group={group} />;
  return null;
}

export function IndicatorPanel({ groups }: Readonly<{ groups: ChartViewModel["groups"] }>) {
  return (
    <aside className={styles.indicatorPanel} aria-labelledby="indicator-heading">
      <div className={styles.sectionHeadingRow}>
        <p className={styles.eyebrow}>事实指标</p>
        <h2 id="indicator-heading">静态指标</h2>
      </div>
      <div role="region" aria-label="静态指标" className={styles.detailsStack}>
        {groups.map((group, index) => (
          <details
            data-group-id={group.id}
            key={group.id}
            open={group.id === "ten-gods" || group.id === "basics"}
            style={{ "--group-order": index } as React.CSSProperties}
          >
            <summary>
              <span>{group.title}</span>
              <small>{group.items.length.toString().padStart(2, "0")}</small>
            </summary>
            <div className={styles.detailBody}><GroupContent group={group} /></div>
          </details>
        ))}
      </div>
    </aside>
  );
}
