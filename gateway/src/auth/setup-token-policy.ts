const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type SetupTokenPolicy = {
  version: number;
  hash: string;
  expiresAt: number;
};

export type SetupTokenPolicyInstallResult =
  | {
      ok: true;
      disposition: "installed" | "unchanged";
      policy: SetupTokenPolicy;
    }
  | {
      ok: false;
      reason: "stale_version" | "version_conflict";
      currentVersion: number;
    };

export class SetupTokenPolicyValidationError extends Error {
  constructor() {
    super("Invalid managed setup-token policy");
    this.name = "SetupTokenPolicyValidationError";
  }
}

export function parseSetupTokenPolicy(input: unknown): SetupTokenPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SetupTokenPolicyValidationError();
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "expiresAt,hash,version") {
    throw new SetupTokenPolicyValidationError();
  }
  if (
    typeof record.version !== "number"
    || !Number.isSafeInteger(record.version)
    || record.version < 1
    || typeof record.hash !== "string"
    || !SHA256_HEX_RE.test(record.hash)
    || typeof record.expiresAt !== "number"
    || !Number.isSafeInteger(record.expiresAt)
    || record.expiresAt < 1
  ) {
    throw new SetupTokenPolicyValidationError();
  }
  return {
    version: record.version,
    hash: record.hash,
    expiresAt: record.expiresAt,
  };
}

export function sameSetupTokenPolicy(
  left: SetupTokenPolicy,
  right: SetupTokenPolicy,
): boolean {
  return left.version === right.version
    && left.hash === right.hash
    && left.expiresAt === right.expiresAt;
}
