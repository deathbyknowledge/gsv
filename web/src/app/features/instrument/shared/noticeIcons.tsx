import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";

type NoticeTopic = Extract<ProcHistoryEvent, { kind: "owner.notified" }>["payload"]["topic"];

/** One mark per kind of notice, shared by its setting and its card so the two read as the same thing. */
export const NOTICE_ICONS = {
  "contact.request": "M3 3h14v10H8l-5 4V3Zm5 3.5a2 2 0 1 1 3 1.73c-.7.4-1 .8-1 1.57m0 1.2v.5",
  "contact.message": "M3 3h14v10H8l-5 4V3Zm4 4h6M7 10h4",
  "contact.invite.accepted": "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5m1-7 2 2 4-4",
  "mail.received": "M2 4h16v12H2V4Zm0 1 8 6 8-6",
  "machine.added": "M4 4h12v9H4V4Zm-2 12h16",
  "adapter.connected": "M7 2v5m6-5v5M5 7h10v3a5 5 0 0 1-10 0V7Zm5 8v3",
  "adapter.auth_required": "M10 3 2 17h16L10 3Zm0 5v5m0 2v.5",
  "event.received": "M2 10h4l2-5 4 10 2-5h4",
  "event.silent": "M2 10h16M6 7v6m8-6v6",
} as const satisfies Record<NoticeTopic, string>;

export function NoticeIcon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d={path} /></svg>;
}
