import Link from "next/link";

import type { ChartViewModel } from "../../lib/chart-view-model";
import { IndicatorPanel } from "./indicator-panel";
import { PillarGrid } from "./pillar-grid";
import { TimeAuditPanel } from "./time-audit-panel";
import styles from "./chart-workbench.module.css";

const precisionLabels: Readonly<Record<string, string>> = Object.freeze({
  exact: "精确",
  approximate: "约略",
  unknown: "未知",
});

interface ChartWorkbenchProps {
  readonly viewModel: ChartViewModel;
  readonly onRestart?: () => void;
}

export function ChartWorkbench({ viewModel, onRestart }: ChartWorkbenchProps) {
  const precisionLabel = precisionLabels[viewModel.summary.timePrecision ?? "unknown"] ?? "未知";

  return (
    <div className={styles.workbench}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>出生固定盘 · 静态层</p>
          <h1>四柱命盘</h1>
          <p className={styles.subtitle}>先校时，再排盘。以下内容均为可追溯的固定事实项。</p>
          <Link className={styles.restartLink} href="/" onClick={onRestart}>
            重新录入出生资料
          </Link>
        </div>
        <div className={styles.seal} aria-hidden="true">命盘</div>
      </header>

      <section className={styles.birthSummary} aria-labelledby="birth-summary-heading">
        <h2 id="birth-summary-heading">出生资料摘要</h2>
        <dl>
          <div><dt>出生地</dt><dd>{viewModel.summary.birthplace.name}</dd></div>
          <div><dt>民用时间</dt><dd>{viewModel.summary.localDateTime}</dd></div>
          <div><dt>IANA 时区</dt><dd>{viewModel.summary.timeZone}</dd></div>
          <div><dt>时间精度</dt><dd>{precisionLabel}</dd></div>
          <div>
            <dt>坐标</dt>
            <dd>{viewModel.summary.birthplace.latitude}, {viewModel.summary.birthplace.longitude}</dd>
          </div>
        </dl>
      </section>

      <div className={styles.primaryLayout}>
        <PillarGrid pillars={viewModel.pillars} />
        <IndicatorPanel groups={viewModel.groups} />
      </div>
      <TimeAuditPanel audit={viewModel.timeAudit} />
    </div>
  );
}
