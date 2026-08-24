import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoverDemo } from "@/components/datecn/discover-demo";
import { DemoActionButton } from "@/components/datecn/demo-action-button";
import { MembershipDemo } from "@/components/datecn/membership-demo";
import { MeDemoActions } from "@/components/datecn/me-demo-actions";
import MessagesDemo from "@/app/[locale]/demo/messages/messages-demo";
import { getDemoHome } from "@/modules/demo/demo-service";
import messages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh-CN.json";

const home = getDemoHome("en");
const wrap = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const wrapZh = (node: React.ReactNode) => render(<NextIntlClientProvider locale="zh-CN" messages={zhMessages}>{node}</NextIntlClientProvider>);

describe("DateCN local-only demo interactions", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("filters the eight discover profiles without making a request", () => {
    wrap(<DiscoverDemo locale="en" profiles={home.profiles} />);
    expect(screen.getAllByTestId("demo-profile-card")).toHaveLength(8);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Lina" } });
    expect(screen.getAllByTestId("demo-profile-card")).toHaveLength(1);
    expect(screen.getByText("92% compatible")).toBeTruthy();
  });

  it("keeps composed messages in local component state", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    wrap(<MessagesDemo conversations={home.conversations} profiles={home.profiles} />);
    fireEvent.change(screen.getByPlaceholderText("Write a demo message"), { target: { value: "Hello from the demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Hello from the demo")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens the requested conversation and safely defaults unknown profile context", () => {
    const requested = wrap(<MessagesDemo conversations={home.conversations} initialProfileId="demo-marcus" profiles={home.profiles} />);
    expect(screen.getAllByText("I can share my favorite waterfront walk.")).toHaveLength(2);
    expect(screen.queryByText("Saturday afternoon would be lovely.")).toBeNull();
    requested.unmount();
    wrap(<MessagesDemo conversations={home.conversations} initialProfileId="unknown-profile" profiles={home.profiles} />);
    expect(screen.getByText("Saturday afternoon would be lovely.")).toBeTruthy();
  });

  it("uses localized time copy for locally composed Chinese messages", () => {
    const zhHome = getDemoHome("zh-CN");
    wrapZh(<MessagesDemo conversations={zhHome.conversations} profiles={zhHome.profiles} />);
    fireEvent.change(screen.getByPlaceholderText("输入演示消息"), { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText("刚刚")).toBeTruthy();
    expect(screen.queryByText("Now")).toBeNull();
  });

  it("shows a local notice instead of starting checkout", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    wrap(<MembershipDemo plans={home.plans} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Premium" }));
    expect(screen.getByRole("status").textContent).toBe("Payments are disabled in demo mode.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows local account-action feedback without network requests", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    wrap(<MeDemoActions />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("status").textContent).toContain("Notifications");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provides a persistent accessible label for the message composer", () => {
    wrap(<MessagesDemo conversations={home.conversations} profiles={home.profiles} />);
    expect(screen.getByLabelText("Write a demo message")).toBeTruthy();
  });

  it("labels profile mutations as local demo actions", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    wrap(<DemoActionButton label="Save profile" notice="Demo only — no action was sent." />);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(screen.getByRole("status").textContent).toBe("Demo only — no action was sent.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
