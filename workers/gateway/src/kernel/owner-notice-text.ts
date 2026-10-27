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
  open: (url: string) => string;
};

const WORDS = {
  en: {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} sent you ${count} messages. Latest: ${preview}`,
    attachment: "(attachment)",
    request: (from) => `📬 Message request from ${from}. Read it and decide in People.`,
    accepted: (from) => `🤝 ${from} accepted your invitation. You can message each other in People now.`,
    open: (url) => `Open: ${url}`,
  },
  es: {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} te ha enviado ${count} mensajes. El último: ${preview}`,
    attachment: "(adjunto)",
    request: (from) => `📬 Solicitud de mensaje de ${from}. Léela y decide en Personas.`,
    accepted: (from) => `🤝 ${from} ha aceptado tu invitación. Ya podéis escribiros en Personas.`,
    open: (url) => `Abrir: ${url}`,
  },
  "pt-BR": {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} enviou ${count} mensagens para você. A última: ${preview}`,
    attachment: "(anexo)",
    request: (from) => `📬 Solicitação de mensagem de ${from}. Leia e decida em Contatos.`,
    accepted: (from) => `🤝 ${from} aceitou seu convite. Vocês já podem conversar em Contatos.`,
    open: (url) => `Abrir: ${url}`,
  },
} satisfies Record<NoticeLanguage, NoticeWords>;

/** The owner's language preference, narrowed to a language notices are written in. */
export function noticeLanguage(preference: string | null | undefined): NoticeLanguage {
  const language = preference?.toLowerCase() ?? "";
  if (language === "es" || language.startsWith("es-")) return "es";
  if (language === "pt" || language.startsWith("pt-")) return "pt-BR";
  return "en";
}

/** The notice exactly as the owner reads it. Names and previews come from other people, so they stay on one short line. */
export function renderOwnerNotice(notice: OwnerNotice, language: NoticeLanguage, origin: string | null): string {
  const words = WORDS[language];
  const { subject } = notice;
  const name = oneLine(subject.from, NAME_CHARACTERS) || "?";
  const from = subject.handle ? `${name} (@${oneLine(subject.handle, NAME_CHARACTERS)})` : name;
  const preview = oneLine(subject.preview ?? "", PREVIEW_CHARACTERS) || words.attachment;
  const text = notice.topic === "contact.message"
    ? notice.pendingCount > 1 ? words.messages(from, notice.pendingCount, preview) : words.message(from, preview)
    : notice.topic === "contact.request" ? words.request(from) : words.accepted(from);
  const url = origin ? noticeUrl(notice, origin) : null;
  return url ? `${text}\n${words.open(url)}` : text;
}

function noticeUrl(notice: OwnerNotice, origin: string): string {
  const url = new URL("/people", origin);
  if (notice.topic === "contact.request" && notice.subject.approachId) {
    url.searchParams.set("view", "requests");
    url.searchParams.set("request", notice.subject.approachId);
  } else {
    url.searchParams.set("contact", notice.subject.contactId);
  }
  return url.toString();
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}
