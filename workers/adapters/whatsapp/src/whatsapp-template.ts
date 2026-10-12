import type { ManagedWhatsAppTemplate } from "./managed-config";
import { WHATSAPP_WINDOW_CLOSED_ERROR, type WhatsAppOutboundPayload } from "./whatsapp-api";

/** Body text filed with Meta. The original message stays in the held queue. */
export const WHATSAPP_TEMPLATE_BODY = "Your GSV has a message for you.";
/** Quick-reply button label filed with Meta; a tap reopens the window. */
export const WHATSAPP_TEMPLATE_BUTTON_LABEL = "Read message";
/** Payload of the quick-reply button; a tap carrying it releases the held messages. */
export const WHATSAPP_TEMPLATE_RELEASE_PAYLOAD = "gsvt:show";

export const WHATSAPP_NO_TEMPLATE_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and no template is configured; see the message templates section of workers/adapters/whatsapp/README.md`;
export const WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and attachments cannot wait behind a template; send text only until the person replies`;
export const WHATSAPP_HELD_FULL_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and too many messages are already waiting for this person's reply`;
export const WHATSAPP_HELD_TOO_LONG_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and this message is too long to wait for the person's reply`;

export function buildWhatsAppTemplatePayload(
  to: string,
  template: ManagedWhatsAppTemplate,
): WhatsAppOutboundPayload {
  return {
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: WHATSAPP_TEMPLATE_RELEASE_PAYLOAD }],
        },
      ],
    },
  };
}
