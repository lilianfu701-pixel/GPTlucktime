"use client";

import { useState } from "react";

export function DemoActionButton({ label, notice, className = "datecn-ghost-button" }: { label: string; notice: string; className?: string }) {
  const [message, setMessage] = useState("");
  return <span className="inline-flex flex-col items-start gap-2"><button className={className} data-demo-action onClick={() => setMessage(notice)} type="button">{label}</button><span className="text-xs font-semibold text-[var(--datecn-wine)]" role="status">{message}</span></span>;
}
