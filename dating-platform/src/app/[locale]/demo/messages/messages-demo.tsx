"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { ProfilePhoto } from "@/components/datecn/profile-photo";
import type { DemoConversation, DemoMessage, DemoProfile } from "@/modules/demo/demo-types";

export default function MessagesDemo({ conversations, initialProfileId, profiles }: { conversations: readonly DemoConversation[]; initialProfileId?: string; profiles: readonly DemoProfile[] }) {
  const t = useTranslations("datecn.messages");
  const initialConversation = conversations.find((item) => item.profileId === initialProfileId) ?? conversations[0];
  const [selected, setSelected] = useState(initialConversation?.id ?? "");
  const [draft, setDraft] = useState("");
  const [local, setLocal] = useState<Record<string, readonly DemoMessage[]>>({});
  const [mobileThread, setMobileThread] = useState(false);
  const conversation = conversations.find((item) => item.id === selected) ?? conversations[0];
  const profile = profiles.find((item) => item.id === conversation?.profileId);

  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !conversation) return;
    setLocal((state) => ({ ...state, [conversation.id]: [...(state[conversation.id] ?? conversation.messages), { id: `local-${Date.now()}`, from: "me", text, time: t("now") }] }));
    setDraft("");
  }

  if (!conversation || !profile) return null;
  const thread = local[conversation.id] ?? conversation.messages;
  return <div className="overflow-hidden rounded-3xl bg-white ring-1 ring-[var(--datecn-ring)] md:grid md:min-h-[620px] md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_230px]">
    <section className={`${mobileThread ? "hidden" : "block"} border-r border-[var(--datecn-ring)] md:block`}><h2 className="border-b border-[var(--datecn-ring)] p-4 font-bold">{t("conversations")}</h2>{conversations.map((item) => { const person = profiles.find((candidate) => candidate.id === item.profileId)!; return <button className={`flex w-full gap-3 border-b border-[var(--datecn-ring)] p-4 text-left ${selected === item.id ? "bg-[#fff2ee]" : ""}`} key={item.id} onClick={() => { setSelected(item.id); setMobileThread(true); }} type="button"><ProfilePhoto className="h-12 w-12 shrink-0 rounded-full" name={person.name} position={person.spritePosition} /><span className="min-w-0"><strong className="block">{person.name}</strong><span className="block truncate text-xs text-[var(--datecn-muted)]">{item.preview}</span></span></button>; })}</section>
    <section className={`${mobileThread ? "flex" : "hidden"} min-w-0 flex-col md:flex`}><header className="flex items-center gap-3 border-b border-[var(--datecn-ring)] p-4"><button aria-label={t("back")} className="h-11 w-11 md:hidden" onClick={() => setMobileThread(false)} type="button">←</button><ProfilePhoto className="h-11 w-11 rounded-full" name={profile.name} position={profile.spritePosition} /><div><strong>{profile.name}</strong><p className="text-xs text-[var(--datecn-muted)]">{profile.city}</p></div></header><p className="m-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{t("safety")}</p><div className="flex flex-1 flex-col justify-end gap-3 overflow-y-auto p-4">{thread.map((message) => <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm ${message.from === "me" ? "ml-auto bg-[var(--datecn-wine)] text-white" : "bg-[var(--datecn-cream)]"}`} key={message.id}><p>{message.text}</p><small className="mt-1 block opacity-65">{message.time}</small></div>)}</div><form className="flex gap-2 border-t border-[var(--datecn-ring)] p-3" onSubmit={send}><label className="sr-only" htmlFor="datecn-demo-message">{t("placeholder")}</label><input className="min-h-11 min-w-0 flex-1 rounded-full border border-[var(--datecn-ring)] px-4" id="datecn-demo-message" onChange={(event) => setDraft(event.target.value)} placeholder={t("placeholder")} value={draft} /><button className="datecn-primary-button" type="submit">{t("send")}</button></form></section>
    <aside className="hidden border-l border-[var(--datecn-ring)] p-5 xl:block"><ProfilePhoto className="aspect-square rounded-2xl" name={profile.name} position={profile.spritePosition} /><h2 className="mt-4 text-xl font-bold">{t("about")}</h2><p className="mt-2 text-sm leading-6 text-[var(--datecn-muted)]">{profile.bio}</p></aside>
  </div>;
}
