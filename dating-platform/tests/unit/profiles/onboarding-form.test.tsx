import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import OnboardingForm from "@/app/[locale]/(member)/onboarding/onboarding-form";

describe("onboarding persisted photo state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("renders pending and rejected states safely after reload", () => {
    const { container } = render(<OnboardingForm
      locale="en"
      initialProfile={null}
      initialPhotos={[
        { id: "pending-1", status: "pending", reason: null, width: null, height: null, createdAt: "2026-08-05T12:00:00.000Z" },
        { id: "rejected-1", status: "rejected", reason: "PHOTO_INVALID_FILE", width: null, height: null, createdAt: "2026-08-05T12:01:00.000Z" },
      ]}
    />);
    expect(screen.getByText("Review pending — not public")).toBeTruthy();
    expect(screen.getByText("Rejected: choose a different photo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove rejected photo" })).toBeTruthy();
    expect(container.textContent).not.toContain("objectKey");
  });

  it("saves an incomplete profile as a draft without sending invalid blank fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<OnboardingForm locale="en" initialProfile={null} />);
    const form = within(container);
    fireEvent.change(form.getByLabelText("About you"), { target: { value: "A small draft." } });
    fireEvent.click(form.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ bio: "A small draft.", publish: false });
    expect(body).not.toHaveProperty("displayName");
    expect(body).not.toHaveProperty("birthDate");
  });

  it("renders every photo moderation state in Chinese without English status text", () => {
    const { container } = render(<OnboardingForm locale="zh" initialProfile={null} initialPhotos={[
      { id: "pending-zh", status: "pending", reason: null, width: null, height: null, createdAt: "2026-08-05T12:00:00.000Z" },
      { id: "approved-zh", status: "approved", reason: null, width: 10, height: 10, createdAt: "2026-08-05T12:01:00.000Z" },
      { id: "rejected-zh", status: "rejected", reason: "PHOTO_INVALID_FILE", width: null, height: null, createdAt: "2026-08-05T12:02:00.000Z" },
    ]} />);
    expect(container.textContent).toContain("审核中，暂不公开");
    expect(container.textContent).toContain("已审核，可用于已发布的个人资料");
    expect(container.textContent).toContain("未通过审核：请选择其他照片");
    expect(container.textContent).not.toMatch(/Review pending|Approved and ready|Rejected: choose|Remove rejected/);
    expect(screen.getByRole("button", { name: "移除未通过审核的照片" })).toBeTruthy();
  });

  it("polls safe owner photo state while pending and clears the timer after leaving", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ photos: [{
      id: "pending-1", status: "approved", reason: null, width: 10, height: 10,
      createdAt: "2026-08-05T12:00:00.000Z",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<OnboardingForm locale="en" initialProfile={null} initialPhotos={[
      { id: "pending-1", status: "pending", reason: null, width: null, height: null, createdAt: "2026-08-05T12:00:00.000Z" },
    ]} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/me/photos", { method: "GET" });
    expect(screen.getByText("Approved and ready for your published profile")).toBeTruthy();
    const callsBeforeUnmount = fetchMock.mock.calls.length;
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeUnmount);
  });
});
