import {
  parseInstallationIdentity,
  parseInstallationId,
  type InstallationId,
  type InstallationIdentity,
  type InstallationIdentityInput,
} from "../installation/identity";

type InstallationIdentityRow = {
  installation_id: string;
  handle: string | null;
  canonical_origin: string | null;
};

export class InstallationIdentityStore {
  readonly installationId: InstallationId;
  private identity: InstallationIdentity | null;

  constructor(
    private readonly sql: SqlStorage,
    durableObjectName: string,
  ) {
    this.installationId = parseInstallationId(durableObjectName);
    this.sql.exec(
      `INSERT OR IGNORE INTO installation_identity (record_id, installation_id)
       VALUES (1, ?)`,
      this.installationId,
    );
    const row = this.getRow();
    this.assertDurableObjectName(row);
    this.identity = identityFromRow(row);
  }

  get(): InstallationIdentity | null {
    return this.identity;
  }

  ensure(input: InstallationIdentityInput): InstallationIdentity {
    const identity = parseInstallationIdentity(input);
    if (identity.installationId !== this.installationId) {
      throw new Error("installation identity does not match Kernel Durable Object name");
    }

    const existing = this.identity;
    if (existing) {
      if (
        existing.handle !== identity.handle
        || existing.canonicalOrigin !== identity.canonicalOrigin
      ) {
        throw new Error("installation identity conflicts with persisted Kernel identity");
      }
      return existing;
    }

    this.sql.exec(
      `UPDATE installation_identity
       SET handle = ?, canonical_origin = ?
       WHERE record_id = 1 AND installation_id = ?`,
      identity.handle,
      identity.canonicalOrigin,
      this.installationId,
    );
    this.identity = identity;
    return identity;
  }

  private assertDurableObjectName(row: InstallationIdentityRow): void {
    if (row.installation_id !== this.installationId) {
      throw new Error("persisted installation identity does not match Kernel Durable Object name");
    }
    if ((row.handle === null) !== (row.canonical_origin === null)) {
      throw new Error("persisted installation identity is incomplete");
    }
  }

  private getRow(): InstallationIdentityRow {
    const row = this.sql.exec<InstallationIdentityRow>(
      `SELECT installation_id, handle, canonical_origin
       FROM installation_identity
       WHERE record_id = 1`,
    ).one();
    if (!row) {
      throw new Error("Kernel installation identity is missing");
    }
    return row;
  }
}

function identityFromRow(row: InstallationIdentityRow): InstallationIdentity | null {
  if (!row.handle || !row.canonical_origin) {
    return null;
  }
  return parseInstallationIdentity({
    installationId: row.installation_id,
    handle: row.handle,
    canonicalOrigin: row.canonical_origin,
  });
}
