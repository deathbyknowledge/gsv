import type {
  LinkManagedTelegramActorInput,
  UnlinkManagedTelegramActorInput,
} from "@humansandmachines/gsv/protocol";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationId,
} from "../installation/identity";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export function parseLinkManagedTelegramActorInput(
  value: unknown,
): LinkManagedTelegramActorInput {
  const input = record(value, "Managed Telegram link input");
  const installationId = managedInstallationId(input.installationId);
  const actorId = telegramUserId(input.actorId, "actorId");
  const surfaceId = telegramUserId(input.surfaceId, "surfaceId");
  if (actorId !== surfaceId) {
    throw new Error("Managed Telegram supports direct messages only");
  }
  return {
    operationId: opaqueId(input.operationId, "operationId"),
    installationId,
    principalId: opaqueId(input.principalId, "principalId"),
    localUid: localUid(input.localUid),
    actorId,
    surfaceId,
  };
}

export function parseUnlinkManagedTelegramActorInput(
  value: unknown,
): UnlinkManagedTelegramActorInput {
  const input = record(value, "Managed Telegram unlink input");
  const installationId = managedInstallationId(input.installationId);
  const actorId = telegramUserId(input.actorId, "actorId");
  const surfaceId = telegramUserId(input.surfaceId, "surfaceId");
  if (actorId !== surfaceId) {
    throw new Error("Managed Telegram supports direct messages only");
  }
  return {
    operationId: opaqueId(input.operationId, "operationId"),
    installationId,
    actorId,
    surfaceId,
    expectedLocalUid: localUid(input.expectedLocalUid),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required`);
  }
  return value as Record<string, unknown>;
}

function opaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function managedInstallationId(value: unknown): string {
  const installationId = parseInstallationId(value);
  if (installationId === LEGACY_STANDALONE_INSTALLATION_ID) {
    throw new Error("Managed Telegram cannot address singleton");
  }
  return installationId;
}

function telegramUserId(value: unknown, field: string): string {
  if (typeof value !== "string" || !TELEGRAM_USER_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function localUid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) {
    throw new Error("localUid is invalid");
  }
  return value as number;
}
