import { normalizeE164 } from "../config/parsing";
import type { Gateway } from "./do";
import type { InviteRecord } from "./registry-store";

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LENGTH = 8;

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeInviteCode(value: string): string {
  return value
    .trim()
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

function normalizeSenderId(value: string): string {
  const e164 = normalizeE164(value);
  if (e164) {
    return e164;
  }
  return normalizeId(value);
}

function generateInviteCode(length: number = INVITE_CODE_LENGTH): string {
  const random = crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (let index = 0; index < random.length; index += 1) {
    code += INVITE_CODE_ALPHABET[random[index] % INVITE_CODE_ALPHABET.length];
  }
  return code;
}

function hasInviteCodeCollision(
  invites: Record<string, InviteRecord>,
  code: string,
): boolean {
  return Object.values(invites).some((invite) => invite.code === code);
}

function ensureSenderAllowedForChannel(
  gw: Gateway,
  channel: string,
  senderId: string,
): void {
  const normalizedChannel = normalizeId(channel);
  const normalizedSenderId = normalizeSenderId(senderId);
  const channelConfig = gw.getConfigPath(`channels.${normalizedChannel}`) as
    | { dmPolicy?: string; allowFrom?: string[] }
    | undefined;

  if (!channelConfig || channelConfig.dmPolicy === "open") {
    return;
  }

  const allowFrom = Array.isArray(channelConfig.allowFrom)
    ? channelConfig.allowFrom
    : [];
  if (allowFrom.includes(normalizedSenderId)) {
    return;
  }

  gw.setConfigPath(`channels.${normalizedChannel}.allowFrom`, [
    ...allowFrom,
    normalizedSenderId,
  ]);
}

function claimFailureMessage(reason: string): string {
  switch (reason) {
    case "not-found":
      return "Invite code not found.";
    case "expired":
      return "Invite code has expired.";
    case "revoked":
      return "Invite code has been revoked.";
    case "already-claimed":
      return "Invite code has already been claimed.";
    case "principal-mismatch":
      return "Invite code is bound to a different principal.";
    default:
      return "Invite claim failed.";
  }
}

export type CreateInviteInput = {
  code?: string;
  homeSpaceId: string;
  homeAgentId?: string;
  role?: string;
  principalId?: string;
  ttlMinutes?: number;
};

export type ClaimInviteInput = {
  code: string;
  principalId: string;
  channel?: string;
  senderId?: string;
};

export type ClaimInviteResult =
  | {
    ok: true;
    invite: InviteRecord;
    principalId: string;
    homeSpaceId: string;
    homeAgentId?: string;
    role: string;
  }
  | {
    ok: false;
    reason: string;
    message: string;
  };

export function createInvite(gw: Gateway, input: CreateInviteInput): InviteRecord {
  const homeSpaceId = normalizeId(input.homeSpaceId);
  const homeAgentId = input.homeAgentId
    ? normalizeId(input.homeAgentId)
    : undefined;
  const role = input.role ? normalizeId(input.role) : "member";
  const principalId = input.principalId
    ? normalizeId(input.principalId)
    : undefined;

  const invites = gw.registryStore.listInvites();
  let code = input.code ? normalizeInviteCode(input.code) : "";

  if (code) {
    if (hasInviteCodeCollision(invites, code)) {
      throw new Error(`Invite code already exists: ${code}`);
    }
  } else {
    let attempts = 0;
    do {
      code = generateInviteCode();
      attempts += 1;
    } while (hasInviteCodeCollision(invites, code) && attempts < 16);

    if (hasInviteCodeCollision(invites, code)) {
      throw new Error("Could not allocate unique invite code");
    }
  }

  let expiresAt: number | undefined;
  if (
    typeof input.ttlMinutes === "number" &&
    Number.isFinite(input.ttlMinutes) &&
    input.ttlMinutes > 0
  ) {
    expiresAt = Date.now() + Math.floor(input.ttlMinutes * 60_000);
  }

  return gw.registryStore.createInvite({
    code,
    homeSpaceId,
    homeAgentId,
    role,
    principalId,
    expiresAt,
  });
}

export function claimInviteForPrincipal(
  gw: Gateway,
  input: ClaimInviteInput,
): ClaimInviteResult {
  const principalId = normalizeId(input.principalId);
  const code = normalizeInviteCode(input.code);
  if (!principalId || !code) {
    return {
      ok: false,
      reason: "invalid-claim-input",
      message: "Invite code and principalId are required.",
    };
  }

  const claimed = gw.registryStore.claimInvite(code, principalId);
  if (!claimed.ok) {
    return {
      ok: false,
      reason: claimed.reason,
      message: claimFailureMessage(claimed.reason),
    };
  }

  const invite = claimed.invite;
  const homeSpaceId = normalizeId(invite.homeSpaceId);
  const homeAgentId = invite.homeAgentId
    ? normalizeId(invite.homeAgentId)
    : undefined;
  const role = normalizeId(invite.role || "member");

  gw.registryStore.upsertPrincipalProfile(principalId, {
    homeSpaceId,
    homeAgentId,
    status: "bound",
  });
  gw.registryStore.setMember(homeSpaceId, principalId, role);

  if (input.channel && input.senderId) {
    const channel = normalizeId(input.channel);
    const senderId = normalizeSenderId(input.senderId);
    const pairKey = `${channel}:${senderId}`;
    if (gw.pendingPairs[pairKey]) {
      delete gw.pendingPairs[pairKey];
    }
    ensureSenderAllowedForChannel(gw, channel, senderId);
  }

  return {
    ok: true,
    invite,
    principalId,
    homeSpaceId,
    homeAgentId,
    role,
  };
}
