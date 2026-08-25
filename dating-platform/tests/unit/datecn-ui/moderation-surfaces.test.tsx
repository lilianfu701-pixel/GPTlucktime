import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminModerationActions } from "@/app/[locale]/admin/admin-moderation-actions";
import { AppealSettings } from "@/app/[locale]/(member)/settings/appeals/appeal-settings";
import { MessagesClient } from "@/app/[locale]/(member)/messages/messages-client";
import messages from "../../../messages/en.json";

describe("moderation acceptance surfaces", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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

  it("reports an incoming message with safe linked evidence from the member UI", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/conversations?pageSize")) return new Response(JSON.stringify({ conversations: [{
        id: "00000000-0000-4000-8000-000000000010", profile: {
          id: "00000000-0000-4000-8000-000000000020", displayName: "Alex",
        },
      }] }), { status: 200 });
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{
        id: "00000000-0000-4000-8000-000000000030", conversationId: "00000000-0000-4000-8000-000000000010",
        sequence: 1, sender: "them", body: "unsafe message", createdAt: "2026-08-24T12:00:00.000Z",
      }], nextAfterSequence: null }), { status: 200 });
      if (url.includes("/receipts?")) return new Response(JSON.stringify({ visible: false, receipts: [] }), { status: 200 });
      if (url === "/api/v1/reports" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "case-1", status: "submitted" }), { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<NextIntlClientProvider locale="en" messages={messages}><MessagesClient realtimeUrl={null} /></NextIntlClientProvider>);
    expect(screen.queryByText("Real-time updates unavailable")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Report message" }));
    expect(await screen.findByText("Message reported for moderator review.")).toBeTruthy();
    const report = fetchMock.mock.calls.find(([input]) => String(input) === "/api/v1/reports");
    expect(JSON.parse(String(report?.[1]?.body))).toMatchObject({
      targetProfileId: "00000000-0000-4000-8000-000000000020",
      messageId: "00000000-0000-4000-8000-000000000030",
      conversationId: "00000000-0000-4000-8000-000000000010",
      reason: "HARASSMENT",
    });
    const messageRequestsBeforeReplacement = fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages?")).length;
    view.rerender(<NextIntlClientProvider locale="en" messages={messages}><MessagesClient realtimeUrl="http://127.0.0.1:1" /></NextIntlClientProvider>);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages?")).length)
      .toBeGreaterThan(messageRequestsBeforeReplacement));
  });

  it("refreshes receipts only for the active conversation at a bounded cadence", async () => {
    vi.useFakeTimers();
    const first = "00000000-0000-4000-8000-000000000010";
    const second = "00000000-0000-4000-8000-000000000011";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/conversations?pageSize")) return new Response(JSON.stringify({ conversations: [
        { id: first, profile: { id: "00000000-0000-4000-8000-000000000020", displayName: "Alex" } },
        { id: second, profile: { id: "00000000-0000-4000-8000-000000000021", displayName: "Blair" } },
      ] }), { status: 200 });
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [], nextAfterSequence: null }), { status: 200 });
      if (url.includes("/receipts?")) return new Response(JSON.stringify({ visible: true, receipts: [], nextAfterSequence: null }), { status: 200 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}><MessagesClient realtimeUrl={null} /></NextIntlClientProvider>);

    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("button", { name: "Alex" })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(0);
    const receiptRequests = () => fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/receipts?"));
    expect(receiptRequests()).toHaveLength(1);
    expect(receiptRequests()[0]).toContain(first);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(receiptRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(receiptRequests()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Blair" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(receiptRequests().at(-1)).toContain(second);
  });

  it("keeps the newly selected conversation active when an older send settles", async () => {
    const first = "00000000-0000-4000-8000-000000000010";
    const second = "00000000-0000-4000-8000-000000000011";
    let resolveSend!: (response: Response) => void;
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve; });
    let sendResponseSettled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/conversations?pageSize")) return new Response(JSON.stringify({ conversations: [
        { id: first, profile: { id: "00000000-0000-4000-8000-000000000020", displayName: "Alex" } },
        { id: second, profile: { id: "00000000-0000-4000-8000-000000000021", displayName: "Blair" } },
      ] }), { status: 200 });
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [], nextAfterSequence: null }), { status: 200 });
      if (url.includes("/receipts?")) return new Response(JSON.stringify({ visible: true, receipts: [], nextAfterSequence: null }), { status: 200 });
      if (url.endsWith(`/conversations/${first}/messages`) && init?.method === "POST") {
        const response = await pendingSend;
        sendResponseSettled = true;
        return response;
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}><MessagesClient realtimeUrl={null} /></NextIntlClientProvider>);

    await screen.findByRole("button", { name: "Alex" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`${first}/messages?`))).toBe(true));
    fireEvent.change(screen.getByPlaceholderText("Write a message"), { target: { value: "for Alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith(`/conversations/${first}/messages`) && init?.method === "POST")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Blair" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`${second}/messages?`))).toBe(true));
    const firstRequestsBeforeSettling = fetchMock.mock.calls.filter(([input]) => String(input).includes(`${first}/messages?`)).length;
    resolveSend(new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000030" }), { status: 201 }));
    await waitFor(() => expect(sendResponseSettled).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes(`${first}/messages?`))).toHaveLength(firstRequestsBeforeSettling);
  });

  it("applies a temporary restriction and finalizes the case through explicit controls", async () => {
    const detail = { case: { id: "case-1", status: "under_review", subjectUserId: "user-2",
      targetType: "message", reasonCode: "HARASSMENT", messageId: "message-1", expectedVersion: 0 },
    actions: [], timeline: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "temporary_restriction", version: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "actioned" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <AdminModerationActions queue="reports" itemId="00000000-0000-4000-8000-000000000003" status="under_review" />
    </NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open case" }));
    fireEvent.change(await screen.findByLabelText("Restriction reason"), { target: { value: "Confirmed harassment" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply temporary restriction" }));
    fireEvent.change(await screen.findByLabelText("Final decision summary"), { target: { value: "Restriction applied after review" } });
    fireEvent.click(screen.getByRole("button", { name: "Finalize case" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ action: "transition",
      nextStatus: "actioned", finalDecisionSummary: "Restriction applied after review" });
  });
});
