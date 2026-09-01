import {
  extractMessageContent,
  getContentType,
  proto,
  type WAMessage,
} from "@whiskeysockets/baileys";

type TextBearingContent = {
  caption?: string | null;
  text?: string | null;
};

export function whatsAppInboundText(
  message: WAMessage,
  extracted: proto.IMessage | undefined,
  contentType: keyof proto.IMessage | undefined,
): string | undefined {
  // SAFETY: Baileys content type selects a text-bearing message payload.
  const content = contentType && extracted
    ? extracted[contentType] as TextBearingContent | null
    : null;
  return message.message?.conversation
    ?? message.message?.extendedTextMessage?.text
    ?? content?.caption
    ?? content?.text
    ?? whatsAppFallbackText(extracted, contentType);
}

export function quotedWhatsAppMessageText(
  message: proto.IMessage | null | undefined,
): string | undefined {
  const extracted = extractMessageContent(message);
  const contentType = extracted ? getContentType(extracted) : undefined;
  // SAFETY: Baileys content type selects a text-bearing message payload.
  const content = contentType && extracted
    ? extracted[contentType] as TextBearingContent | null
    : null;
  return extracted?.conversation
    ?? extracted?.extendedTextMessage?.text
    ?? content?.caption
    ?? content?.text
    ?? whatsAppFallbackText(extracted, contentType);
}

export function whatsAppFallbackText(
  message: proto.IMessage | undefined,
  contentType: keyof proto.IMessage | undefined,
): string | undefined {
  if (!message || !contentType) return undefined;
  switch (contentType) {
    case "locationMessage":
    case "liveLocationMessage": {
      // SAFETY: location discriminator selects the Baileys location payload.
      const location = message[contentType] as {
        degreesLatitude?: number | null;
        degreesLongitude?: number | null;
        name?: string | null;
        address?: string | null;
      } | null;
      if (!location) return undefined;
      const label = cleanLabel(location.name) ?? cleanLabel(location.address);
      const coordinates = finiteCoordinates(
        location.degreesLatitude,
        location.degreesLongitude,
      );
      return `[Location${label ? `: ${label}` : ""}]${
        coordinates ? ` (${coordinates})` : ""
      }`;
    }
    case "contactMessage": {
      const contact = message.contactMessage;
      const name = cleanLabel(contact?.displayName);
      return name ? `[Contact: ${name}]` : "[Contact]";
    }
    case "contactsArrayMessage": {
      const contacts = message.contactsArrayMessage;
      const name = cleanLabel(contacts?.displayName);
      const count = contacts?.contacts?.length ?? 0;
      return `[Contacts${name ? `: ${name}` : ""}${
        count > 0 ? ` (${count})` : ""
      }]`;
    }
    case "reactionMessage": {
      const reaction = cleanLabel(message.reactionMessage?.text);
      return reaction ? `[Reaction: ${reaction}]` : "[Reaction removed]";
    }
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3": {
      // SAFETY: poll discriminator selects the Baileys poll payload.
      const poll = message[contentType] as {
        name?: string | null;
        options?: Array<{ optionName?: string | null } | null> | null;
      } | null;
      const name = cleanLabel(poll?.name);
      const options = poll?.options
        ?.map((option) => cleanLabel(option?.optionName))
        .filter((option): option is string => !!option)
        .slice(0, 20) ?? [];
      const heading = `[Poll${name ? `: ${name}` : ""}]`;
      return options.length > 0
        ? `${heading}\n${options.map((option) => `- ${option}`).join("\n")}`
        : heading;
    }
    case "pollUpdateMessage":
      return "[Poll response]";
    case "buttonsResponseMessage": {
      const response = message.buttonsResponseMessage;
      const selection = cleanLabel(response?.selectedDisplayText)
        ?? cleanLabel(response?.selectedButtonId);
      return selection ? `[Button response: ${selection}]` : "[Button response]";
    }
    case "listResponseMessage": {
      const response = message.listResponseMessage;
      const selection = cleanLabel(response?.title)
        ?? cleanLabel(response?.singleSelectReply?.selectedRowId)
        ?? cleanLabel(response?.description);
      return selection ? `[List response: ${selection}]` : "[List response]";
    }
    case "templateButtonReplyMessage": {
      const response = message.templateButtonReplyMessage;
      const selection = cleanLabel(response?.selectedDisplayText)
        ?? cleanLabel(response?.selectedId);
      return selection ? `[Button response: ${selection}]` : "[Button response]";
    }
    case "interactiveResponseMessage": {
      const response = message.interactiveResponseMessage;
      const selection = cleanLabel(response?.body?.text)
        ?? cleanLabel(response?.nativeFlowResponseMessage?.name);
      return selection
        ? `[Interactive response: ${selection}]`
        : "[Interactive response]";
    }
    case "groupInviteMessage": {
      const invite = message.groupInviteMessage;
      const groupName = cleanLabel(invite?.groupName);
      return groupName ? `[Group invitation: ${groupName}]` : "[Group invitation]";
    }
    case "productMessage": {
      const title = cleanLabel(message.productMessage?.product?.title);
      return title ? `[Product: ${title}]` : "[Product]";
    }
    case "orderMessage":
      return "[Order]";
    case "paymentInviteMessage":
      return "[Payment invitation]";
    case "requestPhoneNumberMessage":
      return "[Phone number requested]";
    case "eventMessage": {
      const event = message.eventMessage;
      const name = cleanLabel(event?.name);
      return name ? `[Event: ${name}]` : "[Event]";
    }
    default:
      return undefined;
  }
}

function cleanLabel(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function finiteCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string | undefined {
  return latitude !== null
    && latitude !== undefined
    && Number.isFinite(latitude)
    && longitude !== null
    && longitude !== undefined
    && Number.isFinite(longitude)
    ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
    : undefined;
}
