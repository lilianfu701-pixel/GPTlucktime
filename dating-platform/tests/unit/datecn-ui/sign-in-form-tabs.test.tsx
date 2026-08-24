import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import SignInForm from "@/app/[locale]/(auth)/sign-in/sign-in-form";
import messages from "../../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/modules/auth/client", () => ({ authClient: { signIn: { email: vi.fn() } } }));

describe("DateCN sign-in presentation", () => {
  afterEach(cleanup);

  it("switches to a useful, non-submitting registration panel and back", () => {
    render(<NextIntlClientProvider locale="en" messages={messages}><SignInForm locale="en" /></NextIntlClientProvider>);
    const signInTab = screen.getByRole("tab", { name: "Sign in" });
    const registerTab = screen.getByRole("tab", { name: "Create account" });
    expect(signInTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(registerTab);
    expect(registerTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Create account" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Preview your profile" }).getAttribute("href")).toBe("/en/demo/me");

    fireEvent.click(screen.getByRole("button", { name: "Already a member? Sign in" }));
    expect(signInTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("supports keyboard navigation between authentication tabs", () => {
    render(<NextIntlClientProvider locale="en" messages={messages}><SignInForm locale="en" /></NextIntlClientProvider>);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Create account" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Create account" }));
  });
});
