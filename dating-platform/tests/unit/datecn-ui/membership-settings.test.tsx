import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MembershipSettings } from "@/app/[locale]/(member)/settings/membership/membership-settings";
import messages from "../../../messages/en.json";

describe("member membership settings", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("loads public plans and current subscription then opens hosted checkout", async () => {
    const assign = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ plans: [{ planRef: "plus", nameKey: "plans.plus.name",
        descriptionKey: "plans.plus.description", price: { currency: "USD", unitAmount: 1299,
          interval: "monthly", intervalCount: 1, taxMode: "exclusive" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ subscription: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <MembershipSettings locale="en" navigate={assign} />
    </NextIntlClientProvider>);
    expect(await screen.findByText("$12.99 / month")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose Plus" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test"));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/checkout-sessions");
  });

  it("cancels renewal with a fresh idempotency key and updates feedback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ plans: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ subscription: { planRef: "plus", status: "active",
        currentPeriodEnd: "2026-09-24T00:00:00.000Z", cancelAtPeriodEnd: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, pending: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <MembershipSettings locale="en" navigate={vi.fn()} />
    </NextIntlClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel renewal" }));
    expect(await screen.findByText("Cancellation requested. Access remains until the confirmed period end.")).toBeTruthy();
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "PATCH",
      headers: expect.objectContaining({ "idempotency-key": expect.any(String) }) }));
  });

  it("opens the same-origin guarded local checkout adapter", async () => {
    const assign = vi.fn();
    const localCheckout = `${window.location.origin}/api/e2e/stripe-checkout?orderId=order-1&token=test`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ plans: [{ planRef: "plus", nameKey: "plans.plus.name",
        descriptionKey: "plans.plus.description", price: { currency: "USD", unitAmount: 1299,
          interval: "monthly", intervalCount: 1, taxMode: "exclusive" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ subscription: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ checkoutUrl: localCheckout }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <MembershipSettings locale="en" navigate={assign} />
    </NextIntlClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Choose Plus" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(localCheckout));
  });
});
