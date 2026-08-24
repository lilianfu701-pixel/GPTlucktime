import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import SignInForm from "@/app/[locale]/(auth)/sign-in/sign-in-form";
import messages from "../../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const authMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPhoneOtp: vi.fn(),
  verifyPhone: vi.fn(),
}));
vi.mock("@/modules/auth/client", () => ({ authClient: {
  signIn: { email: authMocks.signIn },
  signUp: { email: authMocks.signUp },
  sendVerificationEmail: authMocks.sendVerificationEmail,
  phoneNumber: { sendOtp: authMocks.sendPhoneOtp, verify: authMocks.verifyPhone },
} }));

describe("DateCN sign-in presentation", () => {
  afterEach(cleanup);

  it("switches to a real adult registration form and back", () => {
    render(<NextIntlClientProvider locale="en" messages={messages}><SignInForm locale="en" /></NextIntlClientProvider>);
    const signInTab = screen.getByRole("tab", { name: "Sign in" });
    const registerTab = screen.getByRole("tab", { name: "Create account" });
    expect(signInTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(registerTab);
    expect(registerTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Create account" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Create account" })).toBeTruthy();
    expect(screen.getByLabelText("Date of birth")).toBeTruthy();
    expect(screen.getByLabelText(/I confirm I am at least 18/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Already a member? Sign in" }));
    expect(signInTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("associates adult eligibility errors and sends registration through Better Auth", async () => {
    authMocks.signUp.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    render(<NextIntlClientProvider locale="en" messages={messages}><SignInForm locale="en" /></NextIntlClientProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Email address", { selector: "input[name=registerEmail]" }), { target: { value: "alice@example.test" } });
    fireEvent.change(screen.getByLabelText("Password", { selector: "input[name=registerPassword]" }), { target: { value: "correct-horse-battery" } });
    const birthDate = screen.getByLabelText("Date of birth");
    fireEvent.change(birthDate, { target: { value: "2012-01-01" } });
    fireEvent.click(screen.getByLabelText(/I confirm I am at least 18/));
    fireEvent.submit(screen.getByRole("form", { name: "Create account" }));
    expect(await screen.findByText("You must be at least 18 years old.")).toBeTruthy();
    expect(birthDate.getAttribute("aria-describedby")).toContain("register-error");
    expect(authMocks.signUp).not.toHaveBeenCalled();

    fireEvent.change(birthDate, { target: { value: "1990-01-01" } });
    fireEvent.submit(screen.getByRole("form", { name: "Create account" }));
    await waitFor(() => expect(authMocks.signUp).toHaveBeenCalledWith({
      name: "Alice", email: "alice@example.test", password: "correct-horse-battery",
      callbackURL: "/en/onboarding",
    }));
    expect(await screen.findByText("Check your email to verify your account.")).toBeTruthy();
  });

  it("supports keyboard navigation between authentication tabs", () => {
    render(<NextIntlClientProvider locale="en" messages={messages}><SignInForm locale="en" /></NextIntlClientProvider>);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Create account" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Create account" }));
  });
});
