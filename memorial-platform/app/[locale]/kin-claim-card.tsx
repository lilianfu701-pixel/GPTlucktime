"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type KinCandidateView = {
  personId: string;
  /** The viewer's own name, in their channel's script. */
  name: string;
  /** Pre-rendered "字辈：垂" label, or null. */
  generationLabel: string | null;
};

/**
 * Offers the signed-in person the masked 族谱 node(s) that match their name, so
 * they can take over their own place with one tap. The claim is a POST to the
 * node's claim route; on success the page refreshes and the node becomes theirs.
 */
export function KinClaimCard(props: {
  candidates: KinCandidateView[];
  strings: { lead: string; claim: string; hint: string; claimed: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  async function claim(personId: string): Promise<void> {
    if (busy) return;
    setBusy(personId);
    try {
      const res = await fetch(`/api/family/people/${personId}/claim`, {
        method: "POST",
      });
      if (res.ok) {
        setClaimed(true);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  if (claimed) {
    return (
      <div className="mentionPrompt kinClaim" role="status">
        <p className="mentionPromptLead">{props.strings.claimed}</p>
      </div>
    );
  }

  return (
    <div className="mentionPrompt kinClaim" role="status">
      <p className="mentionPromptLead">{props.strings.lead}</p>
      <ul className="kinClaimList">
        {props.candidates.map((c) => (
          <li key={c.personId} className="kinClaimRow">
            <span className="kinClaimName">
              {c.name}
              {c.generationLabel ? (
                <span className="muted"> · {c.generationLabel}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="button buttonPrimary buttonCompact"
              disabled={busy === c.personId}
              onClick={() => claim(c.personId)}
            >
              {props.strings.claim}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">{props.strings.hint}</p>
    </div>
  );
}
