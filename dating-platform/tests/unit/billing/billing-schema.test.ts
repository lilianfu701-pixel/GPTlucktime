import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

describe("billing schema", () => {
  it("exports the commercial catalog, immutable ledger, webhook, outbox and reconciliation tables", () => {
    for (const name of [
      "billingPlans", "billingPrices", "billingCustomers", "billingOrders", "billingSubscriptions",
      "billingPayments", "billingInvoicePaymentLinks", "billingRefunds", "billingDisputes", "billingWebhookEvents",
      "billingEntitlementOutbox", "billingReconciliationRuns", "billingReconciliationCursors",
      "billingReconciliationCollected", "billingReconciliationItems",
    ]) expect(schema).toHaveProperty(name);
  });
});
