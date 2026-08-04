import type {
  ProcessIdentity,
  ProvisionInstallationInput,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import type { AuthStore } from "./auth-store";
import type { KernelContext } from "./context";
import { handleManagedInstallationSetup } from "./sys/setup";

const MAX_MANAGED_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

type ProvisioningRow = {
  operation_id: string;
  owner_principal_id: string;
  owner_username: string;
  local_uid: number | null;
  provision_version: number;
  state: "provisioning" | "active" | "failed";
};

type MembershipRow = {
  principal_id: string;
  local_uid: number;
  role: "owner" | "admin" | "member";
  state: "active" | "revoked";
};

export type ManagedLoginSession = {
  token: string;
  username: string;
  expiresAt: number;
};

export class ManagedProvisioningStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly auth: AuthStore,
  ) {}

  async provision(
    input: ProvisionInstallationInput,
    ctx: KernelContext,
  ): Promise<ProvisionInstallationResult> {
    const existing = this.getOperation(input.operationId);
    if (existing) {
      assertOperationMatches(existing, input);
      if (existing.state === "active" && existing.local_uid !== null) {
        return resultFromOperation(
          { ...existing, local_uid: existing.local_uid },
          input.installation.installationId,
        );
      }
    } else {
      const activeOwner = this.getActiveOwner();
      if (activeOwner) {
        if (
          activeOwner.principal_id !== input.owner.principalId
          || this.auth.getPasswdByUid(activeOwner.local_uid)?.username !== input.owner.username
        ) {
          throw new Error("Managed installation is already owned by another principal");
        }
        return this.recordReplayAgainstActiveOwner(input, activeOwner);
      }
      const now = Date.now();
      this.storage.sql.exec(
        `INSERT INTO managed_provisioning_operations (
           operation_id, owner_principal_id, owner_username, local_uid,
           provision_version, state, created_at, updated_at, last_error
         ) VALUES (?, ?, ?, NULL, ?, 'provisioning', ?, ?, NULL)`,
        input.operationId,
        input.owner.principalId,
        input.owner.username,
        input.provisionVersion,
        now,
        now,
      );
    }

    try {
      const result = await handleManagedInstallationSetup(input, ctx);
      const now = Date.now();
      this.storage.transactionSync(() => {
        const owner = this.getActiveOwner();
        if (owner && (owner.principal_id !== result.principalId || owner.local_uid !== result.localUid)) {
          throw new Error("Managed installation owner changed during provisioning");
        }
        this.storage.sql.exec(
          `INSERT INTO managed_principal_memberships (
             principal_id, local_uid, role, state, created_at, revoked_at
           ) VALUES (?, ?, 'owner', 'active', ?, NULL)
           ON CONFLICT(principal_id) DO UPDATE SET
             local_uid = excluded.local_uid,
             role = 'owner',
             state = 'active',
             revoked_at = NULL`,
          result.principalId,
          result.localUid,
          now,
        );
        this.storage.sql.exec(
          `UPDATE managed_provisioning_operations
           SET local_uid = ?, state = 'active', updated_at = ?, last_error = NULL
           WHERE operation_id = ?`,
          result.localUid,
          now,
          input.operationId,
        );
      });
      return result;
    } catch (error) {
      this.storage.sql.exec(
        `UPDATE managed_provisioning_operations
         SET state = 'failed', updated_at = ?, last_error = ?
         WHERE operation_id = ? AND state != 'active'`,
        Date.now(),
        managedProvisionErrorCategory(error),
        input.operationId,
      );
      throw error;
    }
  }

  async createLoginSession(input: {
    principalId: string;
    localUid: number;
    expiresAt: number;
  }): Promise<ManagedLoginSession> {
    const membership = this.getMembership(input.principalId);
    if (
      !membership
      || membership.state !== "active"
      || membership.local_uid !== input.localUid
    ) {
      throw new Error("Managed membership is not active");
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= now
      || input.expiresAt > now + MAX_MANAGED_SESSION_MS
    ) {
      throw new Error("Managed session expiry is invalid");
    }
    const issued = await this.auth.issueToken({
      uid: input.localUid,
      kind: "user",
      label: "managed-browser-session",
      allowedRole: "user",
      expiresAt: input.expiresAt,
    });
    try {
      this.storage.sql.exec(
        `INSERT INTO managed_login_sessions (
           token_id, principal_id, local_uid, created_at, expires_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
        issued.tokenId,
        input.principalId,
        input.localUid,
        now,
        input.expiresAt,
      );
    } catch (error) {
      this.auth.revokeToken(issued.tokenId, "managed session persistence failed");
      throw error;
    }
    return {
      token: issued.token,
      username: this.auth.getPasswdByUid(input.localUid)!.username,
      expiresAt: input.expiresAt,
    };
  }

  async authenticateLoginSession(token: string): Promise<ProcessIdentity | null> {
    const result = await this.auth.authenticateTokenValue(token, { role: "user" });
    if (!result.ok) return null;
    const now = Date.now();
    const row = this.storage.sql.exec<{
      local_uid: number;
      expires_at: number;
      revoked_at: number | null;
      membership_state: "active" | "revoked";
    }>(
      `SELECT
         s.local_uid, s.expires_at, s.revoked_at,
         m.state AS membership_state
       FROM managed_login_sessions s
       JOIN managed_principal_memberships m
         ON m.principal_id = s.principal_id
        AND m.local_uid = s.local_uid
       WHERE s.token_id = ?
       LIMIT 1`,
      result.tokenId,
    ).toArray()[0];
    if (
      !row
      || row.local_uid !== result.identity.uid
      || row.revoked_at !== null
      || row.expires_at <= now
      || row.membership_state !== "active"
    ) {
      return null;
    }
    return { ...result.identity, cwd: result.identity.home };
  }

  async revokeLoginSession(token: string): Promise<boolean> {
    const result = await this.auth.authenticateTokenValue(token, { role: "user" });
    if (!result.ok) return false;
    const row = this.storage.sql.exec<{ token_id: string }>(
      "SELECT token_id FROM managed_login_sessions WHERE token_id = ? AND revoked_at IS NULL",
      result.tokenId,
    ).toArray()[0];
    if (!row) return false;
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE managed_login_sessions SET revoked_at = ? WHERE token_id = ?",
        now,
        result.tokenId,
      );
      this.auth.revokeToken(result.tokenId, "managed browser logout");
    });
    return true;
  }

  private recordReplayAgainstActiveOwner(
    input: ProvisionInstallationInput,
    owner: MembershipRow,
  ): ProvisionInstallationResult {
    const now = Date.now();
    this.storage.sql.exec(
      `INSERT INTO managed_provisioning_operations (
         operation_id, owner_principal_id, owner_username, local_uid,
         provision_version, state, created_at, updated_at, last_error
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      input.operationId,
      input.owner.principalId,
      input.owner.username,
      owner.local_uid,
      input.provisionVersion,
      now,
      now,
    );
    return {
      state: "active",
      installationId: input.installation.installationId,
      principalId: owner.principal_id,
      localUid: owner.local_uid,
      username: input.owner.username,
      provisionVersion: input.provisionVersion,
    };
  }

  private getOperation(operationId: string): ProvisioningRow | null {
    return this.storage.sql.exec<ProvisioningRow>(
      `SELECT
         operation_id, owner_principal_id, owner_username, local_uid,
         provision_version, state
       FROM managed_provisioning_operations
       WHERE operation_id = ? LIMIT 1`,
      operationId,
    ).toArray()[0] ?? null;
  }

  private getActiveOwner(): MembershipRow | null {
    return this.storage.sql.exec<MembershipRow>(
      `SELECT principal_id, local_uid, role, state
       FROM managed_principal_memberships
       WHERE role = 'owner' AND state = 'active'
       LIMIT 1`,
    ).toArray()[0] ?? null;
  }

  private getMembership(principalId: string): MembershipRow | null {
    return this.storage.sql.exec<MembershipRow>(
      `SELECT principal_id, local_uid, role, state
       FROM managed_principal_memberships
       WHERE principal_id = ? LIMIT 1`,
      principalId,
    ).toArray()[0] ?? null;
  }
}

function assertOperationMatches(
  row: ProvisioningRow,
  input: ProvisionInstallationInput,
): void {
  if (
    row.owner_principal_id !== input.owner.principalId
    || row.owner_username !== input.owner.username
    || row.provision_version !== input.provisionVersion
  ) {
    throw new Error("Provisioning operation was already used with different input");
  }
}

function resultFromOperation(
  row: ProvisioningRow & { local_uid: number },
  installationId: string,
): ProvisionInstallationResult {
  return {
    state: "active",
    installationId,
    principalId: row.owner_principal_id,
    localUid: row.local_uid,
    username: row.owner_username,
    provisionVersion: row.provision_version,
  };
}

function managedProvisionErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "provision_error";
  if (error.message.includes("already")) return "ownership_conflict";
  if (error.message.includes("owner")) return "owner_mismatch";
  return "provision_error";
}
