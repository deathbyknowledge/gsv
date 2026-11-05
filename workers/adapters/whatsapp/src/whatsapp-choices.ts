import type { WhatsAppJsonValue, WhatsAppOutboundPayload } from "./whatsapp-api";

/** Reply button and list row ids that offer a choice; the webhook relays a tap on one as its title. */
export const WHATSAPP_CHOICE_REPLY_PREFIX = "gsvc:";
/** Meta shows at most three reply buttons, each titled in at most twenty characters. */
const REPLY_BUTTON_LIMIT = 3;
const REPLY_BUTTON_TITLE_LIMIT = 20;
/** A list holds at most ten rows, each titled in at most twenty-four characters. */
const LIST_ROW_LIMIT = 10;
const LIST_ROW_TITLE_LIMIT = 24;
/** The label of the button that opens the list. */
const LIST_BUTTON_LABEL = "Choose one";

/** An interactive message without its body: reply buttons or a list offering every choice. */
export type WhatsAppChoicesControl = { type: "button" | "list"; action: WhatsAppJsonValue };

/**
 * Offers the choices word for word: as reply buttons when they fit, otherwise
 * as a list. Null when neither fits, so the text lists them instead.
 */
export function whatsAppChoicesControl(choices: readonly string[]): WhatsAppChoicesControl | null {
  // A UTF-16 length is never shorter than the count Meta applies.
  const fit = (count: number, titleLimit: number) =>
    choices.length <= count && choices.every((choice) => choice.length <= titleLimit);
  const id = (index: number) => `${WHATSAPP_CHOICE_REPLY_PREFIX}${index + 1}`;
  if (fit(REPLY_BUTTON_LIMIT, REPLY_BUTTON_TITLE_LIMIT)) {
    return {
      type: "button",
      action: { buttons: choices.map((title, index) => ({ type: "reply", reply: { id: id(index), title } })) },
    };
  }
  if (fit(LIST_ROW_LIMIT, LIST_ROW_TITLE_LIMIT)) {
    return {
      type: "list",
      action: { button: LIST_BUTTON_LABEL, sections: [{ rows: choices.map((title, index) => ({ id: id(index), title })) }] },
    };
  }
  return null;
}

export function buildWhatsAppChoicesPayload(
  to: string,
  body: string,
  control: WhatsAppChoicesControl,
): WhatsAppOutboundPayload {
  return { to, type: "interactive", interactive: { type: control.type, body: { text: body }, action: control.action } };
}
