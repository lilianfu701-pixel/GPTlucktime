"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type Claim = {
  id: string;
  memorialId: string;
  slug: string;
  memorialName: string;
  kind: "takeover" | "join";
  requesterName: string;
  relationship: string;
  reason: string;
};

const RELATION: Record<string, string> = {
  spouse: "配偶",
  parent: "父母",
  child: "子女",
  sibling: "兄弟姐妹",
};

/**
 * The platform claims queue: pending认领/参与 requests across all pages, for a
 * super-admin to answer — including seeded pages whose bot-steward owner never
 * signs in. Accept transfers ownership (认领) or adds an editor (参与).
 */
export function AdminClaims(props: { initial: Claim[]; locale: string }) {
  const router = useRouter();
  const [claims, setClaims] = useState<Claim[]>(props.initial);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function respond(
    claim: Claim,
    action: "accept" | "decline",
  ): Promise<void> {
    if (busyId) return;
    setBusyId(claim.id);
    try {
      const res = await fetch(
        `/api/memorials/${claim.memorialId}/takeover/${claim.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (res.ok) {
        setClaims((cur) => cur.filter((c) => c.id !== claim.id));
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  if (claims.length === 0) {
    return <p className="muted">目前没有待处理的认领申请。</p>;
  }

  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {claims.map((c) => (
        <li key={c.id} className="takeoverRow stack">
          <p style={{ margin: 0 }}>
            <span className="adminBadge">
              {c.kind === "join" ? "参与" : "认领"}
            </span>{" "}
            <strong>{c.requesterName || "某人"}</strong>
            <span className="muted"> · {RELATION[c.relationship] ?? c.relationship}</span>
            {" 申请 "}
            <Link href={`/${props.locale}/memorials/${c.slug}`}>
              {c.memorialName}
            </Link>
          </p>
          {c.reason ? (
            <p className="muted" style={{ margin: 0 }}>
              {c.reason}
            </p>
          ) : null}
          <div className="adminHeadRow">
            <button
              type="button"
              className="button buttonPrimary buttonCompact"
              disabled={busyId === c.id}
              onClick={() => respond(c, "accept")}
            >
              {busyId === c.id ? "处理中…" : c.kind === "join" ? "通过参与" : "通过认领"}
            </button>
            <button
              type="button"
              className="button buttonQuiet buttonCompact"
              disabled={busyId === c.id}
              onClick={() => respond(c, "decline")}
            >
              拒绝
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
