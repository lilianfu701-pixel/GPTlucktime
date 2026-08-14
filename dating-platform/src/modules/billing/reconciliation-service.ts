export type LedgerRow = { id: string; status?: string; amount?: number };
export type LedgerSnapshot = {
  subscriptions: LedgerRow[]; invoices: LedgerRow[]; refunds: LedgerRow[]; disputes: LedgerRow[];
};
type LedgerPage = LedgerSnapshot & { nextCursor: string | null };
export type ReconciliationDiscrepancy = {
  kind: "missing_internal" | "missing_provider" | "value_mismatch";
  objectType: keyof LedgerSnapshot;
  providerObjectId: string;
  internalFingerprint: string | null;
  providerFingerprint: string | null;
};
export type LedgerComparisonRow = {
  objectType: keyof LedgerSnapshot;
  providerObjectId: string;
  provider: LedgerRow | null;
  internal: LedgerRow | null;
};

const emptySnapshot = (): LedgerSnapshot => ({ subscriptions: [], invoices: [], refunds: [], disputes: [] });
const canonicalStatus = (type: keyof LedgerSnapshot, status?: string) => {
  if (type === "subscriptions") {
    if (["past_due", "grace_period", "incomplete", "paused"].includes(status ?? "")) return "past_due";
    if (["unpaid", "incomplete_expired", "expired"].includes(status ?? "")) return "expired";
    return status ?? null;
  }
  if (type === "invoices") return status ?? "paid";
  if (type === "refunds") return null;
  if (["needs_review", "needs_response", "warning_needs_response", "warning_under_review", "under_review"].includes(status ?? "")) {
    return "needs_review";
  }
  return status ?? null;
};
const fingerprint = (type: keyof LedgerSnapshot, row: LedgerRow) => JSON.stringify({
  status: canonicalStatus(type, row.status), amount: row.amount ?? null,
});

export class ReconciliationService {
  private readonly maxPages: number;
  private readonly pagesPerRun: number;

  constructor(private readonly deps: {
    batchSize: number;
    maxPages?: number;
    pagesPerRun?: number;
    store: {
      acquireRun(key: string): Promise<{ id: string; cursor: string | null; phase?: "provider" | "internal" | "compare";
        leaseId?: string; completed?: boolean; discrepancyCount?: number; providerPages?: number;
        internalPages?: number; comparePages?: number } | null>;
      snapshotPage(input: { cursor: string | null; limit: number }): Promise<LedgerPage>;
      saveDiscrepancies(runId: string, rows: ReconciliationDiscrepancy[]): Promise<void>;
      completeRun(runId: string, nextCursor: string | null, leaseId?: string): Promise<void>;
      failRun(runId: string, result: { retryable: boolean; errorCode: string }, leaseId?: string): Promise<void>;
      renewRun?(runId: string, leaseId: string): Promise<void>;
      saveCollectedPage?(runId: string, side: "provider" | "internal", page: LedgerSnapshot): Promise<void>;
      checkpointRun?(runId: string, state: { phase: "provider" | "internal" | "compare";
        cursor: string | null; providerPages: number; internalPages: number; comparePages: number }, leaseId: string): Promise<void>;
      comparisonPage?(runId: string, input: { cursor: string | null; limit: number }): Promise<{
        rows: LedgerComparisonRow[]; nextCursor: string | null;
      }>;
      countDiscrepancies?(runId: string): Promise<number>;
    };
    provider: { listLedgerPage(input: { cursor: string | null; limit: number }): Promise<LedgerPage> };
  }) {
    if (!Number.isInteger(deps.batchSize) || deps.batchSize < 1 || deps.batchSize > 100) throw new Error("INVALID_BATCH_SIZE");
    this.maxPages = deps.maxPages ?? 10_000;
    this.pagesPerRun = deps.pagesPerRun ?? 50;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 10_000) throw new Error("INVALID_MAX_PAGES");
    if (!Number.isInteger(this.pagesPerRun) || this.pagesPerRun < 1 || this.pagesPerRun > 500) {
      throw new Error("INVALID_PAGES_PER_RUN");
    }
  }

  async run(key: string) {
    const run = await this.deps.store.acquireRun(key);
    if (!run) throw new Error("RECONCILIATION_ALREADY_RUNNING");
    if (run.completed) return { runId: run.id, discrepancies: run.discrepancyCount ?? 0, nextCursor: null };
    try {
      if (run.leaseId && this.deps.store.saveCollectedPage && this.deps.store.checkpointRun
        && this.deps.store.comparisonPage) return await this.runResumable({ ...run, leaseId: run.leaseId });
      const [internal, provider] = await Promise.all([
        this.collect((cursor) => this.deps.store.snapshotPage({ cursor, limit: this.deps.batchSize }), run),
        this.collect((cursor) => this.deps.provider.listLedgerPage({ cursor, limit: this.deps.batchSize }), run),
      ]);
      const discrepancies = this.compare(internal, provider);
      await this.saveDiscrepancies(run.id, discrepancies);
      if (run.leaseId) await this.deps.store.completeRun(run.id, null, run.leaseId);
      else await this.deps.store.completeRun(run.id, null);
      return { runId: run.id, discrepancies: discrepancies.length, nextCursor: null };
    } catch (error) {
      const progressErrors = new Set(["RECONCILIATION_CURSOR_CYCLE", "RECONCILIATION_PAGE_LIMIT"]);
      const errorCode = error instanceof Error && progressErrors.has(error.message) ? error.message : "PROVIDER_UNAVAILABLE";
      const failure = { retryable: true, errorCode };
      if (run.leaseId) await this.deps.store.failRun(run.id, failure, run.leaseId);
      else await this.deps.store.failRun(run.id, failure);
      throw new Error("RECONCILIATION_RETRY_LATER");
    }
  }

  private async runResumable(run: { id: string; cursor: string | null; phase?: "provider" | "internal" | "compare";
    leaseId: string; providerPages?: number; internalPages?: number; comparePages?: number }) {
    let phase = run.phase ?? "provider";
    let cursor = run.cursor;
    let providerPages = run.providerPages ?? 0;
    let internalPages = run.internalPages ?? 0;
    let comparePages = run.comparePages ?? 0;
    let pages = 0;
    const seen = new Set<string>();
    if (cursor) seen.add(`${phase}:${cursor}`);
    while (pages < this.pagesPerRun) {
      if (phase === "provider" || phase === "internal") {
        const side = phase;
        const page = side === "provider"
          ? await this.deps.provider.listLedgerPage({ cursor, limit: this.deps.batchSize })
          : await this.deps.store.snapshotPage({ cursor, limit: this.deps.batchSize });
        await this.deps.store.saveCollectedPage!(run.id, side, page);
        pages += 1;
        if (side === "provider") providerPages += 1;
        else internalPages += 1;
        if ((side === "provider" ? providerPages : internalPages) > this.maxPages) {
          throw new Error("RECONCILIATION_PAGE_LIMIT");
        }
        const nextCursor = page.nextCursor;
        if (nextCursor && (nextCursor === cursor || seen.has(`${side}:${nextCursor}`))) {
          throw new Error("RECONCILIATION_CURSOR_CYCLE");
        }
        cursor = nextCursor;
        if (cursor) seen.add(`${side}:${cursor}`);
        else phase = side === "provider" ? "internal" : "compare";
      } else {
        const page = await this.deps.store.comparisonPage!(run.id, { cursor, limit: this.deps.batchSize });
        const discrepancies = this.compareRows(page.rows);
        await this.saveDiscrepancies(run.id, discrepancies);
        pages += 1;
        comparePages += 1;
        if (comparePages > this.maxPages) throw new Error("RECONCILIATION_PAGE_LIMIT");
        const nextCursor = page.nextCursor;
        if (nextCursor && (nextCursor === cursor || seen.has(`compare:${nextCursor}`))) {
          throw new Error("RECONCILIATION_CURSOR_CYCLE");
        }
        cursor = nextCursor;
        if (!cursor) {
          const count = this.deps.store.countDiscrepancies
            ? await this.deps.store.countDiscrepancies(run.id) : discrepancies.length;
          await this.deps.store.completeRun(run.id, null, run.leaseId);
          return { runId: run.id, discrepancies: count, nextCursor: null };
        }
        seen.add(`compare:${cursor}`);
      }
      if (this.deps.store.renewRun) await this.deps.store.renewRun(run.id, run.leaseId);
    }
    await this.deps.store.checkpointRun!(run.id,
      { phase, cursor, providerPages, internalPages, comparePages }, run.leaseId);
    return { runId: run.id, discrepancies: 0, nextCursor: cursor ?? `phase:${phase}` };
  }

  private compareRows(rows: LedgerComparisonRow[]) {
    return rows.flatMap((row): ReconciliationDiscrepancy[] => {
      if (!row.internal) return [{ kind: "missing_internal", objectType: row.objectType,
        providerObjectId: row.providerObjectId, internalFingerprint: null,
        providerFingerprint: fingerprint(row.objectType, row.provider!) }];
      if (!row.provider) return [{ kind: "missing_provider", objectType: row.objectType,
        providerObjectId: row.providerObjectId, internalFingerprint: fingerprint(row.objectType, row.internal),
        providerFingerprint: null }];
      const internalFingerprint = fingerprint(row.objectType, row.internal);
      const providerFingerprint = fingerprint(row.objectType, row.provider);
      return internalFingerprint === providerFingerprint ? [] : [{ kind: "value_mismatch", objectType: row.objectType,
        providerObjectId: row.providerObjectId, internalFingerprint, providerFingerprint }];
    });
  }

  private compare(internal: LedgerSnapshot, provider: LedgerSnapshot) {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    for (const type of ["subscriptions", "invoices", "refunds", "disputes"] as const) {
      const internalMap = new Map(internal[type].map((row) => [row.id, row]));
      const providerMap = new Map(provider[type].map((row) => [row.id, row]));
      for (const row of provider[type]) {
        const local = internalMap.get(row.id);
        if (!local) discrepancies.push({ kind: "missing_internal", objectType: type,
          providerObjectId: row.id, internalFingerprint: null, providerFingerprint: fingerprint(type, row) });
        else if (fingerprint(type, local) !== fingerprint(type, row)) discrepancies.push({ kind: "value_mismatch", objectType: type,
          providerObjectId: row.id, internalFingerprint: fingerprint(type, local), providerFingerprint: fingerprint(type, row) });
      }
      for (const row of internal[type]) if (!providerMap.has(row.id)) discrepancies.push({
        kind: "missing_provider", objectType: type, providerObjectId: row.id,
        internalFingerprint: fingerprint(type, row), providerFingerprint: null,
      });
    }
    return discrepancies;
  }

  private async saveDiscrepancies(runId: string, discrepancies: ReconciliationDiscrepancy[]) {
    for (let index = 0; index < discrepancies.length; index += 400) {
      await this.deps.store.saveDiscrepancies(runId, discrepancies.slice(index, index + 400));
    }
  }

  private async collect(load: (cursor: string | null) => Promise<LedgerPage>,
    run: { id: string; leaseId?: string }): Promise<LedgerSnapshot> {
    const result = emptySnapshot();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageCount = 0; pageCount < this.maxPages; pageCount += 1) {
      const page = await load(cursor);
      for (const type of ["subscriptions", "invoices", "refunds", "disputes"] as const) result[type].push(...page[type]);
      if (run.leaseId && this.deps.store.renewRun) await this.deps.store.renewRun(run.id, run.leaseId);
      if (!page.nextCursor) return result;
      if (seenCursors.has(page.nextCursor)) throw new Error("RECONCILIATION_CURSOR_CYCLE");
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("RECONCILIATION_PAGE_LIMIT");
  }
}
