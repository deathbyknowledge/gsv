import type { AdapterSendAction, ProcHistoryEventLink } from "@humansandmachines/gsv/protocol";
import type { OwnerNotice } from "./owner-notice-store";

const PREVIEW_CHARACTERS = 200;
const NAME_CHARACTERS = 64;

type NoticeLanguage = "en" | "es" | "pt-BR";

type NoticeWords = {
  message: (from: string, preview: string) => string;
  messages: (from: string, count: number, preview: string) => string;
  attachment: string;
  request: (from: string) => string;
  accepted: (from: string) => string;
  /** Button labels, at most 20 characters for WhatsApp. */
  openContact: string;
  openRequest: string;
};

const WORDS = {
  en: {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} sent you ${count} messages. Latest: ${preview}`,
    attachment: "(attachment)",
    request: (from) => `📬 Message request from ${from}. Read it and decide in People.`,
    accepted: (from) => `🤝 ${from} accepted your invitation. You can message each other in People now.`,
    openContact: "Open in People",
    openRequest: "Review request",
  },
  es: {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} te ha enviado ${count} mensajes. El último: ${preview}`,
    attachment: "(adjunto)",
    request: (from) => `📬 Solicitud de mensaje de ${from}. Léela y decide en Personas.`,
    accepted: (from) => `🤝 ${from} ha aceptado tu invitación. Ya podéis escribiros en Personas.`,
    openContact: "Abrir en Personas",
    openRequest: "Revisar solicitud",
  },
  "pt-BR": {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} enviou ${count} mensagens para você. A última: ${preview}`,
    attachment: "(anexo)",
    request: (from) => `📬 Solicitação de mensagem de ${from}. Leia e decida em Contatos.`,
    accepted: (from) => `🤝 ${from} aceitou seu convite. Vocês já podem conversar em Contatos.`,
    openContact: "Abrir em Contatos",
    openRequest: "Revisar solicitação",
  },
} satisfies Record<NoticeLanguage, NoticeWords>;

/** The owner's language preference, narrowed to a language notices are written in. */
export function noticeLanguage(preference: string | null | undefined): NoticeLanguage {
  const language = preference?.toLowerCase() ?? "";
  if (language === "es" || language.startsWith("es-")) return "es";
  if (language === "pt" || language.startsWith("pt-")) return "pt-BR";
  return "en";
}

/** Who a notice is from and what they wrote. They come from other people, so each stays on one short line. */
export type OwnerNoticeParts = { from: string; handle?: string; preview?: string };

export function ownerNoticeParts(notice: OwnerNotice): OwnerNoticeParts {
  const { subject } = notice;
  const handle = subject.handle ? oneLine(subject.handle, NAME_CHARACTERS) : "";
  const preview = notice.topic === "contact.message" ? oneLine(subject.preview ?? "", PREVIEW_CHARACTERS) : "";
  return {
    from: oneLine(subject.from, NAME_CHARACTERS) || "?",
    ...(handle ? { handle } : undefined),
    ...(preview ? { preview } : undefined),
  };
}

/** The notice's line, for a messenger, which carries only text. */
export function renderOwnerNotice(notice: OwnerNotice, language: NoticeLanguage): string {
  const words = WORDS[language];
  const parts = ownerNoticeParts(notice);
  const from = parts.handle ? `${parts.from} (@${parts.handle})` : parts.from;
  const preview = parts.preview ?? words.attachment;
  return notice.topic === "contact.message"
    ? notice.pendingCount > 1 ? words.messages(from, notice.pendingCount, preview) : words.message(from, preview)
    : notice.topic === "contact.request" ? words.request(from) : words.accepted(from);
}

/** What the notice is about, for each client to open in its own way. */
export function ownerNoticeLink(notice: OwnerNotice): ProcHistoryEventLink {
  return notice.topic === "contact.request" && notice.subject.approachId
    ? { kind: "contact.request", requestId: notice.subject.approachId }
    : { kind: "contact", contactId: notice.subject.contactId };
}

/** A messenger opens the link as an address on this Ship; each adapter shows it as a button or a line of text. */
export function messengerNoticeAction(
  link: ProcHistoryEventLink,
  language: NoticeLanguage,
  origin: string | null,
): AdapterSendAction | undefined {
  if (!origin) return undefined;
  const url = new URL("/people", origin);
  if (link.kind === "contact.request") {
    url.searchParams.set("view", "requests");
    url.searchParams.set("request", link.requestId);
  } else {
    url.searchParams.set("contact", link.contactId);
  }
  const words = WORDS[language];
  return { kind: "open", label: link.kind === "contact.request" ? words.openRequest : words.openContact, url: url.toString() };
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}
