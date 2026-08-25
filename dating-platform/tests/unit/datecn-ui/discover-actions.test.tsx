import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoverActions } from "@/app/[locale]/(member)/discover/discover-actions";
import messages from "../../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("member discovery actions", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("likes with idempotency and announces a mutual match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ liked: true, matched: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <DiscoverActions locale="en" profileId="00000000-0000-4000-8000-000000000002" displayName="Bo" />
    </NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Like Bo" }));
    expect(await screen.findByText("It’s a match with Bo!")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/profiles/00000000-0000-4000-8000-000000000002/like",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "idempotency-key": expect.any(String) }) }),
    );
  });

  it("submits an accessible report and blocks further interaction", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "report-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ blocked: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <DiscoverActions locale="en" profileId="00000000-0000-4000-8000-000000000002" displayName="Bo" />
    </NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Report Bo" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "SPAM" } });
    fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "Repeated unsolicited promotion" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByText("Report submitted for review.")).toBeTruthy();
    const reportBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(reportBody).toMatchObject({ targetProfileId: "00000000-0000-4000-8000-000000000002",
      reason: "SPAM", locale: "en", explanation: "Repeated unsolicited promotion" });

    fireEvent.click(screen.getByRole("button", { name: "Block Bo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Like Bo" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Bo is blocked. You can no longer interact.")).toBeTruthy();
  });
});
