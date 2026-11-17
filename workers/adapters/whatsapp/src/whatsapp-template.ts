import type { ManagedWhatsAppTemplate } from "./managed-config";
import { WHATSAPP_WINDOW_CLOSED_ERROR, type WhatsAppOutboundPayload } from "./whatsapp-api";
import { renderWhatsAppText } from "./whatsapp-formatting";

/** Body text filed with Meta; the single parameter carries the message or a preview. */
export const WHATSAPP_TEMPLATE_BODY = "Your Ship sent you a message:\n\n{{1}}\n\nReply to chat with Ship!";
/**
 * Templates sent by earlier releases carried a quick-reply button. A tap on one
 * still reaches Ship as an ordinary reply, under the label it showed.
 */
export const WHATSAPP_TEMPLATE_BUTTON_LABEL = "Show me";
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
      components: [{ type: "body", parameters: [{ type: "text", text: parameter }] }],
    },
  };
}
