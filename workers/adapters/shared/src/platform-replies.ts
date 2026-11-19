/**
 * What a messenger platform says to a sender itself, before or around their Ship: how to connect,
 * a link that cannot be used, a message type it cannot receive. A sender who has no Ship yet has no
 * language preference anywhere, so these replies follow what the messenger tells about the sender:
 * the app's language on Telegram, the number's country on WhatsApp. Ship's own messages follow
 * its owner's preference instead.
 */
export type ReplyLanguage = "en" | "es" | "pt";
export type ReplyMessenger = "Telegram" | "WhatsApp";

export type PlatformReplies = {
  unavailable: string;
  refused: (reason: string) => string;
  move: (current: string, next: string) => string;
  /** The answers to `move`, as buttons: move first, keep second. */
  moveChoices: readonly [string, string];
  kept: (current: string) => string;
  inProgress: string;
  /**
   * With somewhere to sign up, a stranger hears first how to create a Ship; an owner, what to tell
   * theirs, which answers with its setup link. The address stands on its own line with nothing
   * touching it, so no messenger takes punctuation into the link.
   */
  unlinked: (signupUrl?: string) => string;
  linked: (current: string) => string;
  connected: (origin: string) => string;
  unsupported: string;
  mediaUnavailable: string;
  /**
   * What the messenger withheld instead of delivering, as WhatsApp can one photo of an album: asked
   * for again, without listing what Ship receives, since the person may just have sent exactly that.
   */
  mediaWithheld: string;
  messageWithheld: string;
};

/** Countries whose people get Spanish or Portuguese replies, by ISO 3166 code and calling code. */
const COUNTRIES: ReadonlyArray<readonly [ReplyLanguage, string, string]> = [
  ["es", "ES", "34"], ["es", "AD", "376"], ["es", "MX", "52"], ["es", "AR", "54"], ["es", "CO", "57"],
  ["es", "CL", "56"], ["es", "PE", "51"], ["es", "VE", "58"], ["es", "EC", "593"], ["es", "BO", "591"],
  ["es", "PY", "595"], ["es", "UY", "598"], ["es", "GT", "502"], ["es", "SV", "503"], ["es", "HN", "504"],
  ["es", "NI", "505"], ["es", "CR", "506"], ["es", "PA", "507"], ["es", "CU", "53"], ["es", "GQ", "240"],
  ["pt", "PT", "351"], ["pt", "BR", "55"], ["pt", "AO", "244"], ["pt", "MZ", "258"], ["pt", "CV", "238"],
  ["pt", "GW", "245"], ["pt", "ST", "239"], ["pt", "TL", "670"],
];

/** An app's language tag, such as Telegram's `language_code`. Spain's other languages read Spanish. */
export function replyLanguageFromTag(tag: string | undefined): ReplyLanguage {
  const primary = tag?.trim().toLowerCase().split(/[-_]/, 1)[0];
  if (primary === "pt") return "pt";
  return primary === "es" || primary === "ca" || primary === "gl" || primary === "eu" ? "es" : "en";
}

export function replyLanguageFromCountry(country: string): ReplyLanguage {
  return COUNTRIES.find(([, iso]) => iso === country.toUpperCase())?.[0] ?? "en";
}

/** A number in international form, digits only. Calling codes are prefix-free, so the first match is the country. */
export function replyLanguageFromPhoneNumber(digits: string): ReplyLanguage {
  return COUNTRIES.find(([, , code]) => digits.startsWith(code))?.[0] ?? "en";
}

const UNSUPPORTED_KINDS = {
  en: { Telegram: "text or a supported attachment", WhatsApp: "text, a photo, a document, a voice note or a location" },
  es: { Telegram: "texto o un archivo adjunto compatible", WhatsApp: "texto, una foto, un documento, una nota de voz o una ubicación" },
  pt: { Telegram: "texto ou um anexo compatível", WhatsApp: "texto, uma foto, um documento, uma mensagem de voz ou uma localização" },
} as const;

const ENGLISH = (messenger: ReplyMessenger): PlatformReplies => {
  const askShip = `tell it “connect my ${messenger}” and it will send you a link.`;
  return {
    unavailable: `This link expired or was already used. Make a new one on your Ship in Settings → Messengers → ${messenger}.`,
    refused: (reason) => `Ship could not connect this ${messenger} account: ${reason}`,
    move: (current, next) => `This ${messenger} account talks to the Ship at ${current}. Move it to ${next}?`,
    moveChoices: ["Move it", "Keep it"],
    kept: (current) => `Kept. This ${messenger} account still talks to ${current}.`,
    inProgress: `Ship is still connecting this ${messenger} account. Send your message again in a moment.`,
    unlinked: (signupUrl) => signupUrl
      ? `Hi! To create your Ship, click on this link:\n${signupUrl}\n\nAlready have a Ship? Just ${askShip}`
      : `To talk to your Ship here, ${askShip}`,
    linked: (current) => `This ${messenger} account talks to the Ship at ${current}. To connect it to another Ship, open Settings → Messengers there.`,
    connected: (origin) => `Connected to ${origin}`,
    unsupported: `Ship could not receive that message type. Please send ${UNSUPPORTED_KINDS.en[messenger]}.`,
    mediaUnavailable: "Ship could not receive that attachment. Please send a smaller file or try again.",
    mediaWithheld: `One of your photos or videos didn’t come through from ${messenger}. Please send it again.`,
    messageWithheld: `${messenger} didn’t pass that message on to Ship. Please try sending it another way.`,
  };
};

/** Spain's Spanish, with tú, as the web app speaks it. */
const SPANISH = (messenger: ReplyMessenger): PlatformReplies => {
  const askShip = `dile “conecta mi ${messenger}” y te enviará un enlace.`;
  return {
    unavailable: `Este enlace ha caducado o ya se ha usado. Crea otro en tu Ship, en Ajustes → Mensajería → ${messenger}.`,
    refused: (reason) => `Ship no ha podido conectar esta cuenta de ${messenger}: ${reason}`,
    move: (current, next) => `Esta cuenta de ${messenger} habla con el Ship de ${current}. ¿La pasas a ${next}?`,
    moveChoices: ["Pasarla", "Dejarla"],
    kept: (current) => `Hecho. Esta cuenta de ${messenger} sigue hablando con ${current}.`,
    inProgress: `Ship todavía está conectando esta cuenta de ${messenger}. Vuelve a enviar tu mensaje en un momento.`,
    unlinked: (signupUrl) => signupUrl
      ? `¡Hola! Para crear tu Ship, entra en este enlace:\n${signupUrl}\n\n¿Ya tienes un Ship? Solo ${askShip}`
      : `Para hablar con tu Ship desde aquí, ${askShip}`,
    linked: (current) => `Esta cuenta de ${messenger} habla con el Ship de ${current}. Para conectarla a otro Ship, abre allí Ajustes → Mensajería.`,
    connected: (origin) => `Conectado a ${origin}`,
    unsupported: `Ship no puede recibir este tipo de mensaje. Envía ${UNSUPPORTED_KINDS.es[messenger]}.`,
    mediaUnavailable: "Ship no ha podido recibir ese archivo. Envía uno más pequeño o inténtalo de nuevo.",
    mediaWithheld: `Una de las fotos o vídeos que has enviado no ha llegado desde ${messenger}. Vuelve a enviarla.`,
    messageWithheld: `${messenger} no le ha pasado ese mensaje a Ship. Prueba a enviarlo de otra forma.`,
  };
};

/** Portuguese worded to read naturally in Portugal and in Brazil. */
const PORTUGUESE = (messenger: ReplyMessenger): PlatformReplies => {
  const command = `“conectar o meu ${messenger}” ao seu Ship e ele responde com um link.`;
  return {
    unavailable: `Este link expirou ou já foi usado. Crie outro no seu Ship, em Configurações → Apps de mensagem → ${messenger}.`,
    refused: (reason) => `O Ship não conseguiu conectar esta conta do ${messenger}: ${reason}`,
    move: (current, next) => `Esta conta do ${messenger} fala com o Ship em ${current}. Passar para ${next}?`,
    moveChoices: ["Passar", "Manter"],
    kept: (current) => `Feito. Esta conta do ${messenger} continua conectada a ${current}.`,
    inProgress: `O Ship ainda não terminou de conectar esta conta do ${messenger}. Envie a mensagem de novo daqui a pouco.`,
    unlinked: (signupUrl) => signupUrl
      ? `Olá! Para criar o seu Ship, abra este link:\n${signupUrl}\n\nJá tem um Ship? É só enviar ${command}`
      : `Para falar com o seu Ship por aqui, envie ${command}`,
    linked: (current) => `Esta conta do ${messenger} fala com o Ship em ${current}. Para conectá-la a outro Ship, abra lá Configurações → Apps de mensagem.`,
    connected: (origin) => `Conectado a ${origin}`,
    unsupported: `O Ship não consegue receber este tipo de mensagem. Envie ${UNSUPPORTED_KINDS.pt[messenger]}.`,
    mediaUnavailable: "O Ship não conseguiu receber esse anexo. Envie um anexo menor ou tente de novo.",
    mediaWithheld: `Uma das fotos ou vídeos que enviou não chegou pelo ${messenger}. Envie de novo.`,
    messageWithheld: `O ${messenger} não passou essa mensagem ao Ship. Tente enviá-la de outra forma.`,
  };
};

const REPLIES = { en: ENGLISH, es: SPANISH, pt: PORTUGUESE } as const;

export function platformReplies(messenger: ReplyMessenger, language: ReplyLanguage): PlatformReplies {
  return REPLIES[language](messenger);
}

const MOVE_CHOICES = new Set(Object.values(REPLIES).map((replies) => replies("WhatsApp").moveChoices[0]));
const KEEP_CHOICES = new Set(Object.values(REPLIES).map((replies) => replies("WhatsApp").moveChoices[1]));

/**
 * Whether a message answers a still-open question about moving the account to another Ship, in
 * any reply language: the sender's app or number may have changed since it was asked.
 */
export function answersLinkMove(move: { expiresAt: number } | undefined, text: string, now = Date.now()): boolean {
  return move !== undefined && move.expiresAt > now && (MOVE_CHOICES.has(text) || KEEP_CHOICES.has(text));
}

/** Whether an answer to the move question keeps the account where it is. */
export function keepsLink(text: string): boolean {
  return KEEP_CHOICES.has(text);
}
