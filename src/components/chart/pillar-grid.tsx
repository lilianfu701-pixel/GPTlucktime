import type { ChartViewModel } from "../../lib/chart-view-model";
import styles from "./chart-workbench.module.css";

interface PillarGridProps {
  readonly pillars: ChartViewModel["pillars"];
}

export function PillarGrid({ pillars }: PillarGridProps) {
  return (
    <section className={styles.pillarSection}>
      <div className={styles.sectionHeadingRow}>
        <p className={styles.eyebrow}>四柱排布</p>
        <h2 id="pillar-heading">四柱</h2>
      </div>
      <div className={styles.pillarGrid} role="region" aria-label="四柱">
        {pillars.map((pillar, index) => (
          <article
            className={styles.pillar}
            data-pillar={pillar.position}
            key={pillar.position}
            style={{ "--pillar-order": index } as React.CSSProperties}
          >
            <header>
              <span>{pillar.label}</span>
              {pillar.position === "day" ? <strong>日主</strong> : null}
            </header>
            <span className={styles.pillarCharacters} aria-label={pillar.displayValue}>
              <b>{pillar.stem}</b>
              <b>{pillar.branch}</b>
              <span className={styles.visuallyHidden}>{pillar.displayValue}</span>
            </span>
            <small>序号 {pillar.index}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
