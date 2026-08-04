import {
  MANAGED_TELEGRAM_ACCOUNT_ID,
  type LinkManagedTelegramActorInput,
  type LinkManagedTelegramActorResult,
  type UnlinkManagedTelegramActorInput,
  type UnlinkManagedTelegramActorResult,
} from "@humansandmachines/gsv/protocol";
import type { IdentityLinkStore } from "./identity-links";

const MANAGED_TELEGRAM_ADAPTER_ID = "telegram";

type OperationRow = {
  operation_id: string;
  action: "link" | "unlink";
  principal_id: string | null;
  actor_id: string;
  surface_id: string;
  local_uid: number;
  result_removed: number | null;
};

export class ManagedTelegramLinkStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly identityLinks: IdentityLinkStore,
  ) {}

  link(input: LinkManagedTelegramActorInput): LinkManagedTelegramActorResult {
    const replay = this.operation(input.operationId);
    if (replay) {
      assertLinkReplay(replay, input);
      return linkResult(input.installationId, replay);
    }
    const membership = this.storage.sql.exec<{ local_uid: number }>(
      `SELECT local_uid
       FROM managed_principal_memberships
       WHERE principal_id = ? AND local_uid = ? AND state = 'active'
       LIMIT 1`,
      input.principalId,
      input.localUid,
    ).toArray()[0];
    if (!membership) {
      throw new Error("Managed Telegram membership is not active");
    }
    const existing = this.identityLinks.get(
      MANAGED_TELEGRAM_ADAPTER_ID,
      MANAGED_TELEGRAM_ACCOUNT_ID,
      input.actorId,
    );
    if (existing && existing.uid !== input.localUid) {
      throw new Error("Managed Telegram actor is linked to another local user");
    }
    this.storage.transactionSync(() => {
      this.identityLinks.link(
        MANAGED_TELEGRAM_ADAPTER_ID,
        MANAGED_TELEGRAM_ACCOUNT_ID,
        input.actorId,
        input.localUid,
        0,
        {
          managed: true,
          surfaceKind: "dm",
          surfaceId: input.surfaceId,
          operationId: input.operationId,
        },
      );
      this.storage.sql.exec(
        `INSERT INTO managed_telegram_link_operations (
           operation_id, action, principal_id, actor_id, surface_id,
           local_uid, result_removed, created_at
         ) VALUES (?, 'link', ?, ?, ?, ?, NULL, ?)`,
        input.operationId,
        input.principalId,
        input.actorId,
        input.surfaceId,
        input.localUid,
        Date.now(),
      );
    });
    return {
      state: "linked",
      installationId: input.installationId,
      actorId: input.actorId,
      surfaceId: input.surfaceId,
      localUid: input.localUid,
    };
  }

  unlink(input: UnlinkManagedTelegramActorInput): UnlinkManagedTelegramActorResult {
    const replay = this.operation(input.operationId);
    if (replay) {
      assertUnlinkReplay(replay, input);
      return unlinkResult(input.installationId, replay);
    }
    const existing = this.identityLinks.get(
      MANAGED_TELEGRAM_ADAPTER_ID,
      MANAGED_TELEGRAM_ACCOUNT_ID,
      input.actorId,
    );
    if (existing && existing.uid !== input.expectedLocalUid) {
      throw new Error("Managed Telegram actor ownership changed before unlink");
    }
    const removed = existing !== null;
    this.storage.transactionSync(() => {
      if (removed) {
        this.identityLinks.unlink(
          MANAGED_TELEGRAM_ADAPTER_ID,
          MANAGED_TELEGRAM_ACCOUNT_ID,
          input.actorId,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO managed_telegram_link_operations (
           operation_id, action, principal_id, actor_id, surface_id,
           local_uid, result_removed, created_at
         ) VALUES (?, 'unlink', NULL, ?, ?, ?, ?, ?)`,
        input.operationId,
        input.actorId,
        input.surfaceId,
        input.expectedLocalUid,
        removed ? 1 : 0,
        Date.now(),
      );
    });
    return {
      state: "unlinked",
      installationId: input.installationId,
      actorId: input.actorId,
      surfaceId: input.surfaceId,
      localUid: input.expectedLocalUid,
      removed,
    };
  }

  private operation(operationId: string): OperationRow | null {
    return this.storage.sql.exec<OperationRow>(
      `SELECT
         operation_id, action, principal_id, actor_id, surface_id,
         local_uid, result_removed
       FROM managed_telegram_link_operations
       WHERE operation_id = ? LIMIT 1`,
      operationId,
    ).toArray()[0] ?? null;
  }
}

function assertLinkReplay(
  row: OperationRow,
  input: LinkManagedTelegramActorInput,
): void {
  if (
    row.action !== "link"
    || row.principal_id !== input.principalId
    || row.actor_id !== input.actorId
    || row.surface_id !== input.surfaceId
    || row.local_uid !== input.localUid
  ) {
    throw new Error("Managed Telegram operation was already used with different input");
  }
}

function assertUnlinkReplay(
  row: OperationRow,
  input: UnlinkManagedTelegramActorInput,
): void {
  if (
    row.action !== "unlink"
    || row.principal_id !== null
    || row.actor_id !== input.actorId
    || row.surface_id !== input.surfaceId
    || row.local_uid !== input.expectedLocalUid
  ) {
    throw new Error("Managed Telegram operation was already used with different input");
  }
}

function linkResult(
  installationId: string,
  row: OperationRow,
): LinkManagedTelegramActorResult {
  return {
    state: "linked",
    installationId,
    actorId: row.actor_id,
    surfaceId: row.surface_id,
    localUid: row.local_uid,
  };
}

function unlinkResult(
  installationId: string,
  row: OperationRow,
): UnlinkManagedTelegramActorResult {
  return {
    state: "unlinked",
    installationId,
    actorId: row.actor_id,
    surfaceId: row.surface_id,
    localUid: row.local_uid,
    removed: row.result_removed === 1,
  };
}
