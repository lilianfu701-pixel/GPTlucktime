import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminModerationActions } from "@/app/[locale]/admin/admin-moderation-actions";
import { AppealSettings } from "@/app/[locale]/(member)/settings/appeals/appeal-settings";
import messages from "../../../messages/en.json";

describe("moderation acceptance surfaces", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows safe case metadata and an immutable audit timeline before triage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ case: { id: "case-1", status: "submitted",
        subjectUserId: "user-2", targetType: "message", reasonCode: "HARASSMENT", messageId: "message-1",
        expectedVersion: 0 }, actions: [], timeline: [{ id: "event-1", actorRole: "system",
          eventType: "report_submitted", summary: { reasonCode: "HARASSMENT" }, createdAt: "2026-08-24T12:00:00.000Z" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "triaged" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <AdminModerationActions queue="reports" itemId="00000000-0000-4000-8000-000000000003" status="submitted" />
    </NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(await screen.findByText("Audit timeline")).toBeTruthy();
    expect(screen.getByText("Message reference: message-1")).toBeTruthy();
    expect(screen.queryByText(/raw message/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Triage case" }));
    await waitFor(() => expect(fetchMock.mock.calls[1]?.[0]).toContain("/actions"));
  });

  it("lists an appealable case and submits the member statement", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cases: [{ originalCaseId: "00000000-0000-4000-8000-000000000003",
        caseStatus: "actioned", finalizedAt: "2026-08-24T12:00:00.000Z", appeal: null }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "appeal-1", status: "submitted" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}><AppealSettings /></NextIntlClientProvider>);
    fireEvent.change(await screen.findByLabelText("Appeal statement"), { target: { value: "Please review the context." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit appeal" }));
    expect(await screen.findByText("Appeal submitted for independent review.")).toBeTruthy();
  });
});
