import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { DeletionCancellationClient } from "@/app/[locale]/privacy/cancel-deletion/cancellation-client";
import { PrivacyExportDownloadClient } from "@/app/[locale]/privacy/export/[jobId]/download-client";

const credential = "c".repeat(43);

describe("privacy credential landing pages", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/en/privacy/cancel-deletion");
    localStorage.clear(); sessionStorage.clear();
  });

  it("reads a deletion credential only from the fragment and clears it after scoped cancellation", async () => {
    window.history.replaceState({}, "", `/en/privacy/cancel-deletion#credential=${credential}`);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ canceled: true }),
      { status: 200, headers: { "content-type": "application/json" } }));
    render(<DeletionCancellationClient locale="en" />);

    fireEvent.click(await screen.findByRole("button", { name: "confirm" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/v1/me/delete", expect.objectContaining({ method: "DELETE",
      headers: expect.objectContaining({ authorization: `Bearer ${credential}` }) }));
    expect(fetch.mock.calls[0]![0]).not.toContain(credential);
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("keeps an export credential out of the URL and guides an unauthenticated owner to sign in", async () => {
    window.history.replaceState({}, "", `/zh-CN/privacy/export/11111111-1111-4111-8111-111111111111#credential=${credential}`);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    render(<PrivacyExportDownloadClient locale="zh-CN" jobId="11111111-1111-4111-8111-111111111111" />);

    fireEvent.click(await screen.findByRole("button", { name: "download" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/me/export?jobId=11111111-1111-4111-8111-111111111111");
    expect(fetch.mock.calls[0]![0]).not.toContain(credential);
    expect(fetch.mock.calls[0]![1]).toEqual(expect.objectContaining({ headers: {
      "x-export-download-token": credential } }));
    expect((await screen.findByRole("link", { name: "signIn" })).getAttribute("href")).toBe("/zh-CN/sign-in");
    expect(window.location.hash).toContain(credential);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("clears the export fragment only after the attachment body is available", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState({}, "", `/en/privacy/export/${jobId}#credential=${credential}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["export"]), { status: 200 }));
    const createObjectURL = vi.fn(() => "blob:export"); const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<PrivacyExportDownloadClient locale="en" jobId={jobId} />);

    fireEvent.click(await screen.findByRole("button", { name: "download" }));
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(createObjectURL).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
  });
});
