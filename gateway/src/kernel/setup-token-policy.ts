import {
  parseSetupTokenPolicy,
  sameSetupTokenPolicy,
  type SetupTokenPolicy,
  type SetupTokenPolicyInstallResult,
} from "../auth/setup-token-policy";

export const MANAGED_SETUP_TOKEN_POLICY_KEY = "__gsv:managed:setup-token-policy";

type SetupTokenPolicyStorage = Pick<DurableObjectStorage, "kv">;

/**
 * The Kernel Durable Object is the serialization boundary for setup-token
 * installs. Comparison and persistence deliberately contain no awaits, so a
 * late provider request cannot overwrite a policy installed by a newer one.
 */
export class SetupTokenPolicyStore {
  private policy: SetupTokenPolicy | undefined;

  constructor(private readonly storage: SetupTokenPolicyStorage) {
    const stored = storage.kv.get<unknown>(MANAGED_SETUP_TOKEN_POLICY_KEY);
    this.policy = stored === undefined ? undefined : parseSetupTokenPolicy(stored);
  }

  current(): SetupTokenPolicy | undefined {
    return this.policy ? { ...this.policy } : undefined;
  }

  install(input: SetupTokenPolicy): SetupTokenPolicyInstallResult {
    const policy = parseSetupTokenPolicy(input);
    const current = this.policy;
    if (current) {
      if (policy.version < current.version) {
        return {
          ok: false,
          reason: "stale_version",
          currentVersion: current.version,
        };
      }
      if (policy.version === current.version) {
        if (!sameSetupTokenPolicy(policy, current)) {
          return {
            ok: false,
            reason: "version_conflict",
            currentVersion: current.version,
          };
        }
        return {
          ok: true,
          disposition: "unchanged",
          policy: { ...current },
        };
      }
    }

    // Durable storage first, in-memory cache second. A failed persistence
    // cannot produce an acknowledgement or change authorization behavior.
    this.storage.kv.put(MANAGED_SETUP_TOKEN_POLICY_KEY, policy);
    this.policy = policy;
    return {
      ok: true,
      disposition: "installed",
      policy: { ...policy },
    };
  }

  clearAfterErase(): void {
    this.storage.kv.delete(MANAGED_SETUP_TOKEN_POLICY_KEY);
    this.policy = undefined;
  }
}
