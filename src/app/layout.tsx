import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ChartSessionProvider } from "../components/chart-session-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "命盘推演",
  description: "基于出生时间与地点的命盘推演工具。"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <ChartSessionProvider>{children}</ChartSessionProvider>
      </body>
    </html>
  );
}
