import {
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  type WAMessage,
} from "@whiskeysockets/baileys";

const ACTOR_PREFIX = "wa:jid:";
const IDENTITY_PREFIX = "identity:v2:";
const PN_TO_LID_PREFIX = "identity:v2:pn_to_lid:";
const LID_TO_PN_PREFIX = "identity:v2:lid_to_pn:";
const LEGACY_ACTOR_ALIAS_PREFIX = "actor_alias:";
const STORAGE_BATCH_SIZE = 128;

type CanonicalIdentityRecord = {
  canonicalJid: string;
  firstSeenAt: number;
};

export function normalizeWhatsAppJid(jid: string | null | undefined): string | null {
  let normalized = (jid ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith(ACTOR_PREFIX)) {
    normalized = normalized.slice(ACTOR_PREFIX.length);
  }
  return jidNormalizedUser(normalized) || normalized;
}

export function normalizeOutboundWhatsAppJid(
  jidOrPhone: string | null | undefined,
): string {
  const input = (jidOrPhone ?? "").trim();
  if (!input) throw new Error("WhatsApp JID is required");
  const withoutPrefix = input.startsWith(ACTOR_PREFIX)
    ? input.slice(ACTOR_PREFIX.length)
    : input;
  if (!withoutPrefix.includes("@")) {
    const digits = withoutPrefix.replace(/\D/g, "");
    if (!digits) throw new Error("WhatsApp phone number is invalid");
    return `${digits}@s.whatsapp.net`;
  }
  return normalizeWhatsAppJid(withoutPrefix) ?? withoutPrefix.toLowerCase();
}

/**
 * Chooses the stable provider address for a direct outbound conversation.
 *
 * Baileys performs its own PN/LID device enumeration. Sending directly to a
 * known LID can leave it without an encryptable recipient session, while the
 * corresponding phone-number JID lets Baileys resolve every current device.
 */
export function preferredOutboundWhatsAppJid(
  jidOrPhone: string,
  mappedPhoneJid?: string | null,
): string {
  const jid = normalizeOutboundWhatsAppJid(jidOrPhone);
  if (isWhatsAppGroupJid(jid) || isWhatsAppPnJid(jid)) return jid;
  if (isWhatsAppLidJid(jid)) {
    const phoneJid = normalizeWhatsAppJid(mappedPhoneJid);
    return isWhatsAppPnJid(phoneJid) ? phoneJid : jid;
  }
  throw new Error("Unsupported WhatsApp destination");
}

export function isWhatsAppGroupJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && isJidGroup(jid) === true;
}

export function isWhatsAppPnJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string"
    && (isPnUser(jid) === true || isHostedPnUser(jid) === true);
}

export function isWhatsAppLidJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string"
    && (isLidUser(jid) === true || isHostedLidUser(jid) === true);
}

export function isSupportedWhatsAppRemoteJid(
  jid: string | null | undefined,
): jid is string {
  return isWhatsAppGroupJid(jid)
    || isWhatsAppPnJid(jid)
    || isWhatsAppLidJid(jid);
}

export function actorIdFromJid(jid: string): string {
  return `${ACTOR_PREFIX}${jid}`;
}

export function phoneHandleFromJid(jid: string | null | undefined): string | undefined {
  const normalized = normalizeWhatsAppJid(jid);
  const match = normalized?.match(/^(\d+)@(?:s\.whatsapp\.net|hosted)$/);
  return match ? `+${match[1]}` : undefined;
}

export function messageTimestampMs(value: unknown): number | undefined {
  let serialized: string;
  try {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return undefined;
      serialized = String(Math.trunc(value));
    } else if (typeof value === "bigint" || typeof value === "string") {
      serialized = String(value);
    } else if (
      value
      && typeof value === "object"
      && typeof (value as { toString?: unknown }).toString === "function"
    ) {
      serialized = (value as { toString(): string }).toString();
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(serialized)) return undefined;
  const parsed = Number(serialized);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

export async function whatsAppInboundDeliveryId(
  remoteCanonicalJid: string,
  senderCanonicalJid: string | undefined,
  providerMessageId: string,
): Promise<string> {
  const canonical = JSON.stringify({
    version: 2,
    remote: remoteCanonicalJid,
    sender: senderCanonicalJid ?? null,
    messageId: providerMessageId,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `wa:${hex}`;
}

export async function whatsAppSessionScopedDeliveryId(
  sessionEpoch: number,
  deliveryId: string,
): Promise<string> {
  if (sessionEpoch === 0) return deliveryId;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ sessionEpoch, deliveryId })),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `wa-session:${sessionEpoch}:${hex}`;
}

/**
 * Preserves the externally-observed ingress key for pre-upgrade sessions.
 *
 * Gateway receipts created by the legacy adapter are keyed by the raw
 * remote/participant/message tuple. Renaming that key while the same linked
 * device remains active could replay an already-committed ingress. A provider
 * session replacement advances the epoch, after which canonical, session-
 * scoped IDs are safe to use.
 */
export async function whatsAppInboundDeliveryIdForSession(
  sessionEpoch: number,
  input: {
    remoteCanonicalJid: string;
    senderCanonicalJid?: string;
    legacyRemoteJid: string | null | undefined;
    legacyParticipantJid: string | null | undefined;
    providerMessageId: string;
  },
): Promise<string> {
  if (sessionEpoch === 0) {
    return legacyWhatsAppInboundDeliveryId(
      input.legacyRemoteJid,
      input.legacyParticipantJid,
      input.providerMessageId,
    );
  }
  const canonicalId = await whatsAppInboundDeliveryId(
    input.remoteCanonicalJid,
    input.senderCanonicalJid,
    input.providerMessageId,
  );
  return await whatsAppSessionScopedDeliveryId(sessionEpoch, canonicalId);
}

export function whatsAppDeliverySessionEpoch(deliveryId: string): number {
  const match = deliveryId.match(/^wa-session:(\d+):[0-9a-f]{64}$/);
  if (!match) return 0;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

export function legacyWhatsAppInboundDeliveryId(
  remoteJid: string | null | undefined,
  participantJid: string | null | undefined,
  providerMessageId: string | null | undefined,
): string {
  return [
    normalizeWhatsAppJid(remoteJid) ?? "unknown",
    normalizeWhatsAppJid(participantJid) ?? "",
    providerMessageId ?? "",
  ].join(":");
}

export function selectCatchUpMessages(
  messages: readonly WAMessage[],
  maxMessages: number,
  oldestTimestampMs: number,
): WAMessage[] {
  return messages
    .filter((message) => {
      const timestamp = messageTimestampMs(message.messageTimestamp);
      return timestamp === undefined || timestamp >= oldestTimestampMs;
    })
    .sort((left, right) =>
      (messageTimestampMs(left.messageTimestamp) ?? 0)
      - (messageTimestampMs(right.messageTimestamp) ?? 0)
    )
    .slice(-Math.max(1, maxMessages));
}

export function selectInboundUpsertMessages(
  type: "append" | "notify",
  messages: readonly WAMessage[],
  maxCatchUpMessages: number,
  oldestCatchUpTimestampMs: number,
): WAMessage[] {
  return type === "append"
    ? selectCatchUpMessages(messages, maxCatchUpMessages, oldestCatchUpTimestampMs)
    : [...messages];
}

export class WhatsAppIdentityStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async canonicalJid(
    primary: string | null | undefined,
    alternate?: string | null,
  ): Promise<string | null> {
    const jids = uniqueJids(primary, alternate);
    if (jids.length === 0) return null;
    if (isWhatsAppGroupJid(jids[0])) return jids[0];

    return await this.storage.transaction(async (txn) => {
      const legacyPn = await legacyPnForLids(txn, jids);
      const candidates = uniqueJids(...jids, legacyPn);
      const existing = await Promise.all(
        candidates.map((jid) => txn.get<CanonicalIdentityRecord>(identityKey(jid))),
      );
      const chosen = chooseCanonical(candidates, existing, Date.now());
      for (const jid of candidates) {
        await txn.put(identityKey(jid), chosen);
      }
      const lid = candidates.find(isWhatsAppLidJid);
      const pn = candidates.find(isWhatsAppPnJid);
      if (lid && pn) {
        await txn.put(`${PN_TO_LID_PREFIX}${encodeURIComponent(pn)}`, lid);
        await txn.put(`${LID_TO_PN_PREFIX}${encodeURIComponent(lid)}`, pn);
      }
      return chosen.canonicalJid;
    });
  }

  async bindLidPn(lidInput: string, pnInput: string): Promise<void> {
    await this.bindLidPnMappings([{ lid: lidInput, pn: pnInput }]);
  }

  async bindLidPnMappings(
    mappings: ReadonlyArray<{ lid?: string | null; pn?: string | null }>,
  ): Promise<void> {
    const normalized = uniqueMappings(mappings);
    for (let index = 0; index < normalized.length; index += STORAGE_BATCH_SIZE) {
      const batch = normalized.slice(index, index + STORAGE_BATCH_SIZE);
      await this.storage.transaction(async (txn) => {
        for (const { lid, pn } of batch) {
          const [lidIdentity, pnIdentity] = await Promise.all([
            txn.get<CanonicalIdentityRecord>(identityKey(lid)),
            txn.get<CanonicalIdentityRecord>(identityKey(pn)),
          ]);
          const chosen = chooseCanonical(
            [pn, lid],
            [pnIdentity, lidIdentity],
            Date.now(),
          );
          await txn.put(identityKey(lid), chosen);
          await txn.put(identityKey(pn), chosen);
          await txn.put(`${PN_TO_LID_PREFIX}${encodeURIComponent(pn)}`, lid);
          await txn.put(`${LID_TO_PN_PREFIX}${encodeURIComponent(lid)}`, pn);
        }
      });
    }
  }

  async lidForPn(pnInput: string): Promise<string | null> {
    const pn = normalizeWhatsAppJid(pnInput);
    if (!isWhatsAppPnJid(pn)) return null;
    return await this.storage.get<string>(
      `${PN_TO_LID_PREFIX}${encodeURIComponent(pn)}`,
    ) ?? null;
  }

  async pnForLid(lidInput: string): Promise<string | null> {
    const lid = normalizeWhatsAppJid(lidInput);
    if (!isWhatsAppLidJid(lid)) return null;
    const stored = await this.storage.get<string>(
      `${LID_TO_PN_PREFIX}${encodeURIComponent(lid)}`,
    );
    if (isWhatsAppPnJid(normalizeWhatsAppJid(stored))) {
      return normalizeWhatsAppJid(stored);
    }
    const legacy = await legacyPnForLid(this.storage, lid);
    if (!legacy) return null;
    await this.bindLidPn(lid, legacy);
    return legacy;
  }

  async clear(): Promise<void> {
    await this.storage.transaction(async (txn) => {
      for (const prefix of [IDENTITY_PREFIX, LEGACY_ACTOR_ALIAS_PREFIX]) {
        const records = await txn.list({ prefix });
        const keys = [...records.keys()];
        for (let index = 0; index < keys.length; index += STORAGE_BATCH_SIZE) {
          await txn.delete(keys.slice(index, index + STORAGE_BATCH_SIZE));
        }
      }
    });
  }
}

function uniqueMappings(
  mappings: ReadonlyArray<{ lid?: string | null; pn?: string | null }>,
): Array<{ lid: string; pn: string }> {
  const unique = new Map<string, { lid: string; pn: string }>();
  for (const mapping of mappings) {
    const lid = normalizeWhatsAppJid(mapping.lid);
    const pn = normalizeWhatsAppJid(mapping.pn);
    if (!isWhatsAppLidJid(lid) || !isWhatsAppPnJid(pn)) continue;
    unique.set(`${lid}\u0000${pn}`, { lid, pn });
  }
  return [...unique.values()];
}

async function legacyPnForLids(
  storage: Pick<DurableObjectStorage, "get">,
  jids: readonly string[],
): Promise<string | null> {
  for (const jid of jids) {
    if (!isWhatsAppLidJid(jid)) continue;
    const pn = await legacyPnForLid(storage, jid);
    if (pn) return pn;
  }
  return null;
}

async function legacyPnForLid(
  storage: Pick<DurableObjectStorage, "get">,
  lid: string,
): Promise<string | null> {
  const alias = await storage.get<string>(
    `${LEGACY_ACTOR_ALIAS_PREFIX}${actorIdFromJid(lid)}`,
  );
  if (typeof alias !== "string" || !alias.startsWith(ACTOR_PREFIX)) return null;
  const pn = normalizeWhatsAppJid(alias);
  return isWhatsAppPnJid(pn) ? pn : null;
}

function uniqueJids(
  ...values: Array<string | null | undefined>
): string[] {
  return [...new Set(values
    .map((value) => normalizeWhatsAppJid(value))
    .filter((value): value is string => value !== null))];
}

function chooseCanonical(
  jids: string[],
  existing: Array<CanonicalIdentityRecord | undefined>,
  now: number,
): CanonicalIdentityRecord {
  const known = existing
    .filter((record): record is CanonicalIdentityRecord =>
      !!record
      && typeof record.canonicalJid === "string"
      && Number.isFinite(record.firstSeenAt)
    )
    .sort((left, right) =>
      left.firstSeenAt - right.firstSeenAt
      || left.canonicalJid.localeCompare(right.canonicalJid)
    );
  if (known[0]) return known[0];
  return {
    canonicalJid: jids.find((jid) => isWhatsAppPnJid(jid)) ?? jids[0],
    firstSeenAt: now,
  };
}

function identityKey(jid: string): string {
  return `${IDENTITY_PREFIX}${encodeURIComponent(jid)}`;
}
