import { normalizeE164 } from "../config/parsing";

export function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeChannelSenderId(senderId: string): string {
  const normalized = normalizeE164(senderId);
  if (normalized) {
    return normalized;
  }
  return normalizeId(senderId);
}

export function buildChannelPrincipalId(
  channel: string,
  accountId: string,
  senderId: string,
): string {
  return `channel:${normalizeId(channel)}:${normalizeId(accountId)}:${normalizeId(normalizeChannelSenderId(senderId))}`;
}

export function buildPendingBindingKey(
  channel: string,
  senderId: string,
): string {
  return `${normalizeId(channel)}:${normalizeChannelSenderId(senderId)}`;
}
