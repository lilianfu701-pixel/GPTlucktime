import { describe, expect, it, vi } from "vitest";

import { BillingError, ProviderEnrichmentError, WebhookService,
  type NormalizedBillingEvent } from "@/modules/billing/webhook-service";

const event = (overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent => ({
  id: "evt_1", type: "invoice.paid", createdAt: new Date("2026-08-12T12:00:00.000Z"),
  objectId: "in_1", objectVersion: 1775995200, userId: "00000000-0000-4000-8000-000000000001",
  orderId: "00000000-0000-4000-8000-000000000002", providerCustomerId: "cus_1",
  providerSubscriptionId: "sub_1", providerInvoiceId: "in_1", providerPaymentId: "pi_1",
  providerRefundId: null, providerDisputeId: null, amount: 1299, currency: "USD",
  periodStart: new Date("2026-08-01T00:00:00.000Z"), periodEnd: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

describe("WebhookService", () => {
  it("requires a signature and verifies raw bytes before any store write", async () => {
    const verifier = { verifyAndNormalize: vi.fn(() => { throw new Error("bad signature secret"); }) };
    const store = { applyEvent: vi.fn() };
    const service = new WebhookService({ verifier, store });
    await expect(service.handle(new TextEncoder().encode("{}"), "bad"))
      .rejects.toEqual(new BillingError("INVALID_SIGNATURE"));
    expect(store.applyEvent).not.toHaveBeenCalled();
  });

  it("stores only a payload hash plus normalized safe event and treats duplicates as acknowledged", async () => {
    const normalized = event();
    const verifier = { verifyAndNormalize: vi.fn(() => normalized) };
    const store = { applyEvent: vi.fn(async () => ({ duplicate: true, outcome: "duplicate" as const })) };
    const service = new WebhookService({ verifier, store });
    const raw = new TextEncoder().encode('{"secret":"must-not-be-stored"}');
    const result = await service.handle(raw, "signed");
    expect(result).toEqual({ acknowledged: true, duplicate: true });
    expect(store.applyEvent).toHaveBeenCalledWith(normalized, expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(JSON.stringify(store.applyEvent.mock.calls)).not.toContain("must-not-be-stored");
  });

  it("acknowledges unknown verified events", async () => {
    const store = { applyEvent: vi.fn(async () => ({ duplicate: false, outcome: "ignored" as const })) };
    const service = new WebhookService({ verifier: { verifyAndNormalize: () => event({ type: "unknown" }) }, store });
    await expect(service.handle(new TextEncoder().encode("{}"), "signed"))
      .resolves.toEqual({ acknowledged: true, duplicate: false });
  });

  it("keeps verified provider enrichment failures retryable and performs no store write", async () => {
    const store = { applyEvent: vi.fn() };
    const service = new WebhookService({ verifier: { verifyAndNormalize: async () => {
      throw new ProviderEnrichmentError();
    } }, store });
    await expect(service.handle(new TextEncoder().encode("{}"), "valid-signature"))
      .rejects.toEqual(new BillingError("PROVIDER_UNAVAILABLE"));
    expect(store.applyEvent).not.toHaveBeenCalled();
  });
});
