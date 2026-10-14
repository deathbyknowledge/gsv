import type { ManagedWhatsAppTemplate } from "./managed-config";
import { WHATSAPP_WINDOW_CLOSED_ERROR, type WhatsAppOutboundPayload } from "./whatsapp-api";
import { renderWhatsAppText } from "./whatsapp-formatting";

/** Body text filed with Meta; the single parameter carries the message or a preview. */
export const WHATSAPP_TEMPLATE_BODY = "Your GSV has an update about your request: {{1}} Tap below to continue in WhatsApp.";
/** Quick-reply button label filed with Meta; its text is forwarded to Ship. */
export const WHATSAPP_TEMPLATE_BUTTON_LABEL = "Show me";
/** Keep the approved button payload stable across adapter upgrades. */
export const WHATSAPP_TEMPLATE_REPLY_PAYLOAD = "gsvt:show";
const TEMPLATE_PARAMETER_LIMIT = 1024 - [...WHATSAPP_TEMPLATE_BODY.replace("{{1}}", "")].length;
const PREVIEW_SUFFIX = "… Open GSV for the full message.";

export const WHATSAPP_NO_TEMPLATE_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and no template is configured; see the message templates section of workers/adapters/whatsapp/README.md`;
export const WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR =
  `${WHATSAPP_WINDOW_CLOSED_ERROR}, and this template cannot deliver attachments; use another authorized destination or wait for the person to reply`;

export function buildWhatsAppTemplatePayload(
  to: string,
  template: ManagedWhatsAppTemplate,
  markdown: string,
): WhatsAppOutboundPayload {
  // Template parameters cannot contain newlines or tabs. Preserve paragraph
  // boundaries in the compact preview without keeping a second message store.
  const text = renderWhatsAppText(markdown).replace(/\r?\n+/g, " · ").replace(/\s+/g, " ").trim()
    || "You have a new message in GSV.";
  const points = [...text];
  const parameter = points.length <= TEMPLATE_PARAMETER_LIMIT
    ? text
    : points.slice(0, TEMPLATE_PARAMETER_LIMIT - [...PREVIEW_SUFFIX].length).join("").trimEnd() + PREVIEW_SUFFIX;
  return {
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        { type: "body", parameters: [{ type: "text", text: parameter }] },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: WHATSAPP_TEMPLATE_REPLY_PAYLOAD }],
        },
      ],
    },
  };
}
