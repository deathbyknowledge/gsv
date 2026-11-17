import type { ManagedWhatsAppTemplate } from "./managed-config";
import { WHATSAPP_WINDOW_CLOSED_ERROR, type WhatsAppOutboundPayload } from "./whatsapp-api";
import { renderWhatsAppText } from "./whatsapp-formatting";

/**
 * Templates sent by earlier releases carried a quick-reply button. A tap on one
 * still reaches Ship as an ordinary reply, under the label it showed.
 */
export const WHATSAPP_TEMPLATE_BUTTON_LABEL = "Show me";
export const WHATSAPP_TEMPLATE_REPLY_PAYLOAD = "gsvt:show";
/**
 * Meta fills the approved text around the single parameter and caps the result
 * at 1,024 characters. The message takes at most 900 of them, so the adapter
 * never copies the template's text; the approved text stays under 124 characters.
 */
export const WHATSAPP_TEMPLATE_PARAMETER_LIMIT = 900;
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
  const parameter = points.length <= WHATSAPP_TEMPLATE_PARAMETER_LIMIT
    ? text
    : points.slice(0, WHATSAPP_TEMPLATE_PARAMETER_LIMIT - [...PREVIEW_SUFFIX].length).join("").trimEnd() + PREVIEW_SUFFIX;
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
