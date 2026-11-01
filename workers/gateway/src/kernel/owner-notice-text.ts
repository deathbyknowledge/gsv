import { adapterDisplayName, type AdapterSendAction, type NoticeKind, type ProcHistoryEventLink } from "@humansandmachines/gsv/protocol";
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
  mail: (count: number) => string;
  machine: (name: string) => string;
  adapterConnected: (name: string) => string;
  adapterAuth: (name: string) => string;
  stoppedTelling: (what: string) => string;
  startedActing: (what: string) => string;
  /** Each kind's name, for telling the owner their Ship changed its rule. */
  kinds: Record<NoticeKind, string>;
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
    mail: (count) => count > 1 ? `📧 You have ${count} new emails.` : "📧 You have a new email.",
    machine: (name) => `💻 A new computer connected to your Ship: ${name}.`,
    adapterConnected: (name) => `🔌 ${name} is connected to your Ship.`,
    adapterAuth: (name) => `⚠️ ${name} needs signing in again.`,
    stoppedTelling: (what) => `🔧 Your Ship turned off telling you about: ${what}. You can change this in Settings.`,
    startedActing: (what) => `🔧 Your Ship set itself to act on: ${what}. You can change this in Settings.`,
    kinds: {
      "contact.request": "message requests",
      "contact.message": "contact messages",
      "contact.invite.accepted": "accepted invitations",
      "mail.received": "new mail",
      "machine.added": "new computers",
      "adapter.connected": "connected messengers",
      "adapter.auth_required": "messengers that need signing in",
    },
    openContact: "Open in People",
    openRequest: "Review request",
  },
  es: {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} te ha enviado ${count} mensajes. El último: ${preview}`,
    attachment: "(adjunto)",
    request: (from) => `📬 Solicitud de mensaje de ${from}. Léela y decide en Personas.`,
    accepted: (from) => `🤝 ${from} ha aceptado tu invitación. Ya podéis escribiros en Personas.`,
    mail: (count) => count > 1 ? `📧 Tienes ${count} correos nuevos.` : "📧 Tienes un correo nuevo.",
    machine: (name) => `💻 Se ha conectado un ordenador nuevo a tu Ship: ${name}.`,
    adapterConnected: (name) => `🔌 ${name} se ha conectado a tu Ship.`,
    adapterAuth: (name) => `⚠️ Tienes que volver a iniciar sesión en ${name}.`,
    stoppedTelling: (what) => `🔧 Tu Ship ha dejado de avisarte sobre: ${what}. Puedes cambiarlo en Ajustes.`,
    startedActing: (what) => `🔧 Tu Ship se ha configurado para actuar sobre: ${what}. Puedes cambiarlo en Ajustes.`,
    kinds: {
      "contact.request": "solicitudes de mensaje",
      "contact.message": "mensajes de contactos",
      "contact.invite.accepted": "invitaciones aceptadas",
      "mail.received": "correo nuevo",
      "machine.added": "ordenadores nuevos",
      "adapter.connected": "mensajerías conectadas",
      "adapter.auth_required": "mensajerías que piden iniciar sesión",
    },
    openContact: "Abrir en Personas",
    openRequest: "Revisar solicitud",
  },
  "pt-BR": {
    message: (from, preview) => `💬 ${from}: ${preview}`,
    messages: (from, count, preview) => `💬 ${from} enviou ${count} mensagens para você. A última: ${preview}`,
    attachment: "(anexo)",
    request: (from) => `📬 Solicitação de mensagem de ${from}. Leia e decida em Contatos.`,
    accepted: (from) => `🤝 ${from} aceitou seu convite. Vocês já podem conversar em Contatos.`,
    mail: (count) => count > 1 ? `📧 Você tem ${count} e-mails novos.` : "📧 Você tem um e-mail novo.",
    machine: (name) => `💻 Um novo computador se conectou ao seu Ship: ${name}.`,
    adapterConnected: (name) => `🔌 ${name} está conectado ao seu Ship.`,
    adapterAuth: (name) => `⚠️ Você precisa entrar novamente no ${name}.`,
    stoppedTelling: (what) => `🔧 Seu Ship parou de avisar você sobre: ${what}. Você pode mudar isso em Configurações.`,
    startedActing: (what) => `🔧 Seu Ship passou a agir sobre: ${what}. Você pode mudar isso em Configurações.`,
    kinds: {
      "contact.request": "solicitações de mensagem",
      "contact.message": "mensagens de contatos",
      "contact.invite.accepted": "convites aceitos",
      "mail.received": "e-mails novos",
      "machine.added": "computadores novos",
      "adapter.connected": "mensageiros conectados",
      "adapter.auth_required": "mensageiros que pedem login",
    },
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
  const preview = notice.topic === "contact.message" || notice.topic === "mail.received"
    ? oneLine(subject.preview ?? "", PREVIEW_CHARACTERS) : "";
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
  switch (notice.topic) {
    case "contact.message":
      return notice.pendingCount > 1 ? words.messages(from, notice.pendingCount, preview) : words.message(from, preview);
    case "contact.request": return words.request(from);
    case "contact.invite.accepted": return words.accepted(from);
    // An email's sender and words stay out of a messenger; the person reads them in their Ship.
    case "mail.received": return words.mail(notice.pendingCount);
    case "machine.added": return words.machine(parts.from);
    case "adapter.connected": return words.adapterConnected(adapterDisplayName(notice.subject.adapter ?? parts.from));
    case "adapter.auth_required": return words.adapterAuth(adapterDisplayName(notice.subject.adapter ?? parts.from));
    case "notice.rule.changed": {
      // SAFETY: the Kernel writes this subject from a validated rule kind, never from outside.
      const what = words.kinds[notice.subject.from as NoticeKind];
      return notice.subject.ruleChange === "started-acting" ? words.startedActing(what) : words.stoppedTelling(what);
    }
  }
}

/** What the notice is about, for each client to open in its own way. */
export function ownerNoticeLink(notice: OwnerNotice): ProcHistoryEventLink | undefined {
  if (notice.topic === "contact.request" && notice.subject.approachId) return { kind: "contact.request", requestId: notice.subject.approachId };
  return notice.subject.contactId ? { kind: "contact", contactId: notice.subject.contactId } : undefined;
}

/** A messenger opens the link as an address on this Ship; each adapter shows it as a button or a line of text. */
export function messengerNoticeAction(
  link: ProcHistoryEventLink | undefined,
  language: NoticeLanguage,
  origin: string | null,
): AdapterSendAction | undefined {
  if (!origin || !link) return undefined;
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
