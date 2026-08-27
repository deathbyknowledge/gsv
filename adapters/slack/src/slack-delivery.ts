import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import { cancelBinaryBody } from "../../shared/src/media-body";
import type {
  AdapterOutboundMessage,
  AdapterSendResult,
  BinaryBody,
} from "./types";
import {
  postSlackMessage,
  requireSlackId,
  SlackApiError,
  type SlackFetch,
} from "./slack-api";

export type SlackDeliveryOptions = {
  slackFetch?: SlackFetch;
  attributedActorId?: string;
};

export async function deliverSlackMessage(
  deliveries: DeliveryLedger,
  botToken: string | null,
  message: AdapterOutboundMessage,
  body?: BinaryBody,
  options: SlackDeliveryOptions = {},
): Promise<AdapterSendResult> {
  if (!botToken) {
    await cancelBinaryBody(body, "Slack bot token is not configured");
    return { ok: false, error: "Slack bot token is not configured" };
  }
  if ((message.media?.length ?? 0) > 0 || body) {
    await cancelBinaryBody(body, "Slack media delivery is not supported yet");
    return { ok: false, error: "Slack media delivery is not supported yet" };
  }

  let channel: string;
  let renderedText: string;
  try {
    channel = requireSlackId(message.surface.id, "Slack channel");
    renderedText = renderSlackMessageText(message, options.attributedActorId);
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
  if (!renderedText) return { ok: false, error: "Slack messages require text" };

  let fingerprint: string;
  try {
    fingerprint = await fingerprintOutboundDelivery({
      ...message,
      text: renderedText,
    });
  } catch {
    return { ok: false, error: "Could not fingerprint Slack delivery", retryable: true };
  }
  let claim;
  try {
    claim = await deliveries.claim(message.deliveryId, fingerprint);
  } catch {
    return { ok: false, error: "Slack delivery ledger unavailable", retryable: true };
  }
  if (!claim.claimed) return claim.result;

  const fail = async (
    kind: DeliveryFailureKind,
    error: string,
  ): Promise<AdapterSendResult> => {
    if (kind === "retryable") {
      await deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
      return { ok: false, error, retryable: true };
    }
    if (kind === "ambiguous") {
      await deliveries.failAmbiguous(message.deliveryId, claim.attemptId, error);
      return { ok: false, error, ambiguous: true };
    }
    await deliveries.failPermanent(message.deliveryId, claim.attemptId, error);
    return { ok: false, error };
  };

  try {
    const sent = await postSlackMessage(botToken, {
      channel,
      text: renderedText,
      threadTs: message.surface.threadId,
    }, options.slackFetch);
    await deliveries.succeed(message.deliveryId, claim.attemptId, sent.ts);
    return { ok: true, messageId: sent.ts };
  } catch (error) {
    const kind = error instanceof SlackApiError ? error.kind : "permanent";
    return await fail(kind, "Slack delivery failed");
  }
}

export function renderSlackMessageText(
  message: AdapterOutboundMessage,
  attributedActorId?: string,
): string {
  const text = message.text.trim();
  if (!text) return "";
  if (message.surface.kind === "dm") return text;
  if (!attributedActorId || message.actorId !== attributedActorId) {
    throw new Error("Slack shared-surface attribution is invalid");
  }
  const actorId = requireSlackId(attributedActorId, "Slack actor");
  return `*From <@${actorId}>'s GSV:*
${text}`;
}

function safeError<T>(error: T): string {
  return error instanceof Error && /Slack|attribution|text/.test(error.message)
    ? error.message
    : "Slack delivery is invalid";
}
