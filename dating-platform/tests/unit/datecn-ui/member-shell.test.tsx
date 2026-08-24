import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import { MemberShell } from "@/components/datecn/member-shell";
import { SiteHeader } from "@/components/datecn/site-header";
import messages from "../../../messages/en.json";

let pathname = "/en/demo/messages";
let query = "with=demo-marcus";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(query),
}));

describe("DateCN member shell", () => {
  afterEach(() => {
    cleanup();
    pathname = "/en/demo/messages";
    query = "with=demo-marcus";
  });

  it("keeps locale-aware navigation and marks the active destination", () => {
    render(<NextIntlClientProvider locale="en" messages={messages}><MemberShell locale="en" active="discover"><p>Demo body</p></MemberShell></NextIntlClientProvider>);

    const discoverLinks = screen.getAllByRole("link", { name: "Discover" });
    expect(discoverLinks.length).toBeGreaterThan(0);
    expect(discoverLinks.every((link) => link.getAttribute("href") === "/en/demo/discover")).toBe(true);
    expect(discoverLinks.every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeTruthy();
    expect(screen.getByText("Demo mode")).toBeTruthy();
    expect(screen.getByText("Demo body")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Member navigation" }).querySelectorAll("a")).toHaveLength(5);
    expect(screen.getByRole("navigation", { name: "Mobile navigation" }).querySelectorAll("a")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "简体中文" }).getAttribute("href")).toBe("/zh/demo/messages?with=demo-marcus");
  });

  it("preserves profile routes and query context when switching languages", () => {
    pathname = "/en/demo/profile/demo-lina";
    query = "with=demo-marcus&source=match";
    render(<NextIntlClientProvider locale="en" messages={messages}><SiteHeader labels={{ brand: "DateCN", language: "简体中文", signIn: "Sign in" }} locale="en" /></NextIntlClientProvider>);

    expect(screen.getByRole("link", { name: "简体中文" }).getAttribute("href")).toBe("/zh/demo/profile/demo-lina?with=demo-marcus&source=match");
  });
});
