import {
  hashPassword,
  isLocked,
  isValidPasswordHash,
  makeShadowEntry,
  verify,
} from "../../auth/shadow";
import type { KernelContext } from "../context";
import { SERVER_RELEASE } from "../../version";
import type { PasswdEntry } from "../../auth/passwd";
import type { ProcessIdentity, SysSetupArgs, SysSetupResult, UserIdentity } from "@humansandmachines/gsv/protocol";
import { handleSysBootstrap } from "./bootstrap";
import { ensureAccountHomeLayout } from "../account-home";
import { RipgitClient } from "../../fs";
import { seedRepoSkillsToHome } from "./skills-seed";
import { ensurePersonalAgent } from "../agents";
import { provisionEnabledPackagesForCaller } from "../package-agents";
import { ACCOUNT_USERNAME_RE, canonicalizeLoginUsername } from "../../auth/login";

const SETUP_COMMISSIONING_STATE_KEY = "internal/setup/commissioning";
const SETUP_COMMISSIONING_LEASE_MS = 15 * 60 * 1000;
const SETUP_NODE_LIFETIME_MIN_TOLERANCE_MS = 5_000;
const SETUP_NODE_LIFETIME_MAX_TOLERANCE_MS = 60_000;

type SetupCommissioningStatus = "in-progress" | "retryable" | "completed";

type SetupCommissioningState = {
  version: 2;
  attemptId: string;
  status: SetupCommissioningStatus;
  username: string;
  uid: number;
  agentName: string | null;
  requestHash: string;
  passwordHash: string;
  rootPasswordHash: string;
  nodeExpiryLifetimeMs: number | null;
  startedAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
  mutationStarted: boolean;
};

function parseSetupCommissioningState(raw: string | null): SetupCommissioningState | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("System setup state is invalid; recovery required");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("System setup state is invalid; recovery required");
  }

  const state = parsed as Partial<SetupCommissioningState>;
  if (
    state.version !== 2 ||
    typeof state.attemptId !== "string" ||
    state.attemptId.length === 0 ||
    !["in-progress", "retryable", "completed"].includes(state.status ?? "") ||
    typeof state.username !== "string" ||
    !ACCOUNT_USERNAME_RE.test(state.username) ||
    !Number.isSafeInteger(state.uid) ||
    (state.uid ?? -1) < 1000 ||
    (state.agentName !== null && (
      typeof state.agentName !== "string" || !ACCOUNT_USERNAME_RE.test(state.agentName)
    )) ||
    typeof state.requestHash !== "string" ||
    !isValidPasswordHash(state.requestHash) ||
    typeof state.passwordHash !== "string" ||
    !isValidPasswordHash(state.passwordHash) ||
    typeof state.rootPasswordHash !== "string" ||
    !isValidPasswordHash(state.rootPasswordHash) ||
    (state.nodeExpiryLifetimeMs !== null && (
      typeof state.nodeExpiryLifetimeMs !== "number"
      || !Number.isSafeInteger(state.nodeExpiryLifetimeMs)
      || state.nodeExpiryLifetimeMs <= 0
    )) ||
    typeof state.startedAt !== "number" ||
    !Number.isFinite(state.startedAt) ||
    typeof state.updatedAt !== "number" ||
    !Number.isFinite(state.updatedAt) ||
    typeof state.leaseExpiresAt !== "number" ||
    !Number.isFinite(state.leaseExpiresAt) ||
    typeof state.mutationStarted !== "boolean"
  ) {
    throw new Error("System setup state is invalid; recovery required");
  }

  return state as SetupCommissioningState;
}

function readSetupCommissioningState(config: KernelContext["config"]): SetupCommissioningState | null {
  return parseSetupCommissioningState(config.get(SETUP_COMMISSIONING_STATE_KEY));
}

export function isSetupCommissioningPending(config: KernelContext["config"]): boolean {
  const state = readSetupCommissioningState(config);
  return state !== null && state.status !== "completed";
}

/**
 * Claim commissioning synchronously before the first external await.
 *
 * ConfigStore writes to the Kernel DO's SQLite database synchronously. Durable
 * Objects do not interleave another event until this handler awaits, so this
 * read/write pair is the setup ownership boundary without holding a lock over
 * any external I/O.
 */
function claimSetupCommissioning(
  config: KernelContext["config"],
  input: {
    username: string;
    uid: number;
    agentName: string | null;
    requestHash: string;
    passwordHash: string;
    rootPasswordHash: string;
    nodeExpiryLifetimeMs: number | null;
  },
): SetupCommissioningState {
  const existing = readSetupCommissioningState(config);
  const now = Date.now();
  if (existing) {
    if (existing.status === "completed") {
      throw new Error("System already initialized");
    }
    if (existing.status === "in-progress" && existing.leaseExpiresAt > now) {
      throw new Error("System setup is already in progress");
    }
    if (
      existing.username !== input.username
      || existing.requestHash !== input.requestHash
      || existing.agentName !== input.agentName
      || !sameSetupNodeExpiryPolicy(
        existing.nodeExpiryLifetimeMs,
        input.nodeExpiryLifetimeMs,
      )
    ) {
      throw new Error("Setup retry does not match the claimed commissioning request");
    }
    const resumed: SetupCommissioningState = {
      ...existing,
      attemptId: crypto.randomUUID(),
      status: "in-progress",
      updatedAt: now,
      leaseExpiresAt: now + SETUP_COMMISSIONING_LEASE_MS,
    };
    config.set(SETUP_COMMISSIONING_STATE_KEY, JSON.stringify(resumed));
    return resumed;
  }

  const claimed: SetupCommissioningState = {
    version: 2,
    attemptId: crypto.randomUUID(),
    status: "in-progress",
    ...input,
    startedAt: now,
    updatedAt: now,
    leaseExpiresAt: now + SETUP_COMMISSIONING_LEASE_MS,
    mutationStarted: false,
  };
  config.set(SETUP_COMMISSIONING_STATE_KEY, JSON.stringify(claimed));
  return claimed;
}

function transitionSetupCommissioning(
  config: KernelContext["config"],
  claimed: SetupCommissioningState,
  status: SetupCommissioningStatus,
  mutationStarted: boolean,
): SetupCommissioningState {
  const current = readSetupCommissioningState(config);
  if (
    !current ||
    current.status !== "in-progress" ||
    current.attemptId !== claimed.attemptId
  ) {
    throw new Error("System setup ownership was lost; recovery required");
  }

  const next: SetupCommissioningState = {
    ...current,
    status,
    mutationStarted,
    updatedAt: Date.now(),
    leaseExpiresAt: status === "in-progress"
      ? Date.now() + SETUP_COMMISSIONING_LEASE_MS
      : current.leaseExpiresAt,
  };
  config.set(SETUP_COMMISSIONING_STATE_KEY, JSON.stringify(next));
  return next;
}

type SetupTiming = {
  label: string;
  ms: number;
};

async function timeSetupStep<T>(
  timings: SetupTiming[],
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings.push({ label, ms: Date.now() - startedAt });
  }
}

function formatSetupTimings(timings: SetupTiming[]): string {
  if (timings.length === 0) {
    return "no steps completed";
  }
  return timings.map((timing) => `${timing.label}=${timing.ms}ms`).join(", ");
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readRequiredSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalFutureTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("node.expiresAt must be a unix timestamp in milliseconds");
  }
  const ts = Math.floor(value);
  if (ts <= Date.now()) {
    throw new Error("node.expiresAt must be in the future");
  }
  return ts;
}

function ensureSingleUserBootstrap(passwd: PasswdEntry[]): void {
  if (passwd.some((entry) => entry.uid >= 1000)) {
    throw new Error("System already initialized");
  }
}

function parseSetupIdentity(args: SysSetupArgs): { username: string; password: string } {
  const raw = args as Record<string, unknown>;
  const username = canonicalizeLoginUsername(raw.username);
  if (!username) {
    throw new Error(
      "username must match ^[a-z_][a-z0-9_-]{0,31}$",
    );
  }

  const password = readRequiredSecret(raw.password, "password");
  if (password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  return { username, password };
}

function parseSetupAgentName(
  value: unknown,
  username: string,
): string | undefined {
  const agentName = readOptionalString(value);
  if (!agentName) return undefined;
  if (!ACCOUNT_USERNAME_RE.test(agentName)) {
    throw new Error("agentName must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  if (agentName === username) {
    throw new Error("agentName must be different from username");
  }
  return agentName;
}

function assertSetupAgentNameAvailable(
  auth: KernelContext["auth"],
  agentName: string | undefined,
): void {
  if (
    agentName
    && (
      auth.isAccountNameReserved(agentName)
      || auth.getPasswdByUsername(agentName)
      || auth.getGroupByName(agentName)
    )
  ) {
    throw new Error(`agentName is unavailable: ${agentName}`);
  }
}

function setupRequestProof(input: unknown): string {
  return JSON.stringify(input);
}

function parseAiConfig(args: SysSetupArgs): { provider?: string; model?: string; apiKey?: string } {
  const raw = args as Record<string, unknown>;
  if (!raw.ai || typeof raw.ai !== "object") {
    return {};
  }
  const ai = raw.ai as Record<string, unknown>;
  return {
    provider: readOptionalString(ai.provider),
    model: readOptionalString(ai.model),
    apiKey: typeof ai.apiKey === "string" ? ai.apiKey : undefined,
  };
}

function parseTimezone(args: SysSetupArgs): string | undefined {
  const raw = args as Record<string, unknown>;
  const timezone = readOptionalString(raw.timezone);
  if (!timezone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("timezone must be a valid IANA timezone");
  }
  return timezone;
}

function parseNodeConfig(args: SysSetupArgs): {
  deviceId: string;
  label?: string;
  expiresAt?: number;
} | null {
  const raw = args as Record<string, unknown>;
  if (!raw.node || typeof raw.node !== "object") {
    return null;
  }
  const node = raw.node as Record<string, unknown>;
  const deviceId = readRequiredString(node.deviceId, "node.deviceId");
  return {
    deviceId,
    label: readOptionalString(node.label),
    expiresAt: parseOptionalFutureTimestamp(node.expiresAt),
  };
}

function setupNodeRequestProof(
  node: ReturnType<typeof parseNodeConfig>,
): { deviceId: string; label: string | null; expiring: boolean } | null {
  if (!node) return null;
  return {
    deviceId: node.deviceId,
    label: node.label ?? null,
    // The CLI derives the absolute timestamp from a user-selected lifetime.
    // Bind that expiry was requested, not the wall-clock value, so a retry can
    // supply a new future deadline without changing device identity or intent.
    expiring: node.expiresAt !== undefined,
  };
}

function setupNodeExpiryLifetimeMs(
  node: ReturnType<typeof parseNodeConfig>,
): number | null {
  if (node?.expiresAt === undefined) return null;
  const lifetimeMs = Math.floor(node.expiresAt - Date.now());
  if (lifetimeMs <= 0) {
    throw new Error("node.expiresAt must be in the future");
  }
  return lifetimeMs;
}

function sameSetupNodeExpiryPolicy(
  reservedLifetimeMs: number | null,
  requestedLifetimeMs: number | null,
): boolean {
  if (reservedLifetimeMs === null || requestedLifetimeMs === null) {
    return reservedLifetimeMs === requestedLifetimeMs;
  }
  const toleranceMs = Math.max(
    SETUP_NODE_LIFETIME_MIN_TOLERANCE_MS,
    Math.min(
      SETUP_NODE_LIFETIME_MAX_TOLERANCE_MS,
      Math.floor(reservedLifetimeMs / 100),
    ),
  );
  return Math.abs(reservedLifetimeMs - requestedLifetimeMs) <= toleranceMs;
}

export async function handleSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
  options: {
    provisionUserKernels?: (result: SysSetupResult) => Promise<void>;
  } = {},
): Promise<SysSetupResult> {
  const { auth, config } = ctx;
  const rawArgs = args as Record<string, unknown>;
  const requestedUsername = typeof rawArgs.username === "string" && rawArgs.username.trim().length > 0
    ? rawArgs.username.trim()
    : "<unknown>";
  const startedAt = Date.now();
  const timings: SetupTiming[] = [];

  const { username, password } = parseSetupIdentity(args);
  const ai = parseAiConfig(args);
  const timezone = parseTimezone(args);
  const node = parseNodeConfig(args);
  const nodeExpiryLifetimeMs = setupNodeExpiryLifetimeMs(node);
  const rootPassword = readOptionalSecret((args as Record<string, unknown>).rootPassword);
  if (rootPassword && rootPassword.length < 8) {
    throw new Error("rootPassword must be at least 8 characters");
  }

  const agentName = parseSetupAgentName(
    (args as Record<string, unknown>).agentName,
    username,
  );
  const existingCommissioning = readSetupCommissioningState(config);
  if (!existingCommissioning) {
    if (!auth.isSetupMode()) {
      throw new Error("System already initialized");
    }
    ensureSingleUserBootstrap(auth.getPasswdEntries());
    if (auth.getPasswdByUsername(username)) {
      throw new Error(`User already exists: ${username}`);
    }
    assertSetupAgentNameAvailable(auth, agentName);
  }

  const bootstrapArgs = rawArgs.bootstrap && typeof rawArgs.bootstrap === "object"
    ? rawArgs.bootstrap as Record<string, unknown>
    : {};
  const requestProof = setupRequestProof({
    username,
    password,
    rootPassword: rootPassword ?? null,
    agentName: agentName ?? null,
    bootstrap: {
      remoteUrl: readOptionalString(bootstrapArgs.remoteUrl) ?? null,
      repo: readOptionalString(bootstrapArgs.repo) ?? null,
      ref: readOptionalString(bootstrapArgs.ref) ?? null,
    },
    ai: {
      provider: ai.provider ?? null,
      model: ai.model ?? null,
      apiKey: ai.apiKey ?? null,
    },
    timezone: timezone ?? null,
    node: setupNodeRequestProof(node),
  });
  let requestHash: string;
  if (existingCommissioning) {
    const matchesExistingRequest = await timeSetupStep(
      timings,
      "verify-request",
      () => verify(requestProof, existingCommissioning.requestHash),
    );
    if (!matchesExistingRequest) {
      throw new Error("Setup retry does not match the claimed commissioning request");
    }
    requestHash = existingCommissioning.requestHash;
  } else {
    // The proof includes passwords, provider credentials, and potentially
    // credential-bearing bootstrap URLs. Protect it with the same salted,
    // deliberately slow KDF as a password verifier; a fast request digest
    // would become an offline oracle for those secrets.
    requestHash = await timeSetupStep(
      timings,
      "hash-request",
      () => hashPassword(requestProof),
    );
  }
  const passwordHash = existingCommissioning?.passwordHash
    ?? await timeSetupStep(timings, "hash-password", () => hashPassword(password));
  const rootPasswordHash = existingCommissioning?.rootPasswordHash
    ?? (rootPassword
      ? await timeSetupStep(timings, "hash-root-password", () => hashPassword(rootPassword))
      : passwordHash);
  const reservedUid = existingCommissioning?.uid ?? auth.allocateUid();

  let bootstrap: SysSetupResult["bootstrap"];
  let nodeToken: SysSetupResult["nodeToken"];
  const commissioning = claimSetupCommissioning(config, {
    username,
    uid: reservedUid,
    agentName: agentName ?? null,
    requestHash,
    passwordHash,
    rootPasswordHash,
    nodeExpiryLifetimeMs,
  });
  let mutationStarted = commissioning.mutationStarted;
  const checkpoint = (mutated = mutationStarted) => {
    transitionSetupCommissioning(config, commissioning, "in-progress", mutated);
    mutationStarted = mutated;
  };

  try {
    const uid = commissioning.uid;
    // User Private Group (UPG): each user gets a unique primary group with gid = uid.
    // Shared capabilities still flow through supplementary membership in `users` (gid 100).
    const gid = uid;
    const home = `/home/${username}`;
    const bootstrapProcessIdentity: ProcessIdentity = {
      uid,
      gid,
      gids: [gid],
      username,
      home,
      cwd: home,
    };
    const rootProcessIdentity: ProcessIdentity = {
      uid: 0,
      gid: 0,
      gids: [0],
      username: "root",
      home: "/root",
      cwd: "/root",
    };
    const bootstrapIdentity: UserIdentity = {
      role: "user",
      process: bootstrapProcessIdentity,
      capabilities: ["*"],
    };

    if (ctx.env.RIPGIT) {
      bootstrap = await timeSetupStep(
        timings,
        "bootstrap-system",
        () => handleSysBootstrap(rawArgs.bootstrap as SysSetupArgs["bootstrap"], {
          ...ctx,
          identity: bootstrapIdentity,
        }),
      );
      checkpoint();
    }

    await timeSetupStep(timings, "write-auth-state", () => {
      const writeAuthState = () => {
        const existing = auth.getPasswdByUsername(username);
        if (existing) {
          if (
            existing.uid !== uid
            || existing.gid !== gid
            || existing.home !== home
            || existing.shell !== "/bin/init"
          ) {
            throw new Error("Setup identity does not match the commissioning reservation");
          }
        } else {
          auth.addUser({
            username,
            uid,
            gid,
            gecos: username,
            home,
            shell: "/bin/init",
          }, "human");
          auth.setShadow(makeShadowEntry(username, commissioning.passwordHash));
        }

        // Private primary group (gid = uid) owned by this user.
        if (!auth.getGroupByName(username) && !auth.getGroupByGid(gid)) {
          auth.addGroup({ name: username, gid, members: [] });
        }

        const usersGroup = auth.getGroupByName("users");
        if (usersGroup && !usersGroup.members.includes(username)) {
          auth.updateGroupMembers("users", [...usersGroup.members, username]);
        }

        const rootShadow = auth.getShadowByUsername("root");
        if (!rootShadow || isLocked(rootShadow)) {
          if (!auth.setPassword("root", commissioning.rootPasswordHash)) {
            throw new Error("Root account is missing during setup");
          }
        }
        ctx.userKernels?.reserve(username, uid);
      };

      if (ctx.transactionSync) {
        ctx.transactionSync(writeAuthState);
      } else {
        writeAuthState();
      }
    });
    checkpoint(true);

    await timeSetupStep(timings, "write-system-config", () => {
      if (timezone !== undefined) {
        config.set("config/server/timezone", timezone);
      }
    });

    await timeSetupStep(timings, "write-ai-config", () => {
      if (ai.provider !== undefined) {
        config.set(`users/${uid}/ai/provider`, ai.provider);
      }
      if (ai.model !== undefined) {
        config.set(`users/${uid}/ai/model`, ai.model);
      }
      if (ai.apiKey !== undefined) {
        config.set(`users/${uid}/ai/api_key`, ai.apiKey);
      }
    });
    checkpoint(true);

    if (node) {
      nodeToken = await timeSetupStep(timings, "issue-node-token", async () => {
        if (node.expiresAt !== undefined && node.expiresAt <= Date.now()) {
          throw new Error("node.expiresAt must be in the future");
        }
        for (const token of auth.listTokens(uid)) {
          if (
            token.kind === "node"
            && token.allowedDeviceId === node.deviceId
            && token.revokedAt === null
          ) {
            auth.revokeToken(token.tokenId, "superseded setup credential", uid);
          }
        }
        const issued = await auth.issueToken({
          uid,
          kind: "node",
          label: node.label ?? `node:${node.deviceId}`,
          allowedRole: "driver",
          allowedDeviceId: node.deviceId,
          expiresAt: node.expiresAt,
        });
        return {
          tokenId: issued.tokenId,
          token: issued.token,
          tokenPrefix: issued.tokenPrefix,
          uid: issued.uid,
          kind: "node",
          label: issued.label,
          allowedRole: "driver",
          allowedDeviceId: issued.allowedDeviceId,
          createdAt: issued.createdAt,
          expiresAt: issued.expiresAt,
        };
      });
      checkpoint(true);
    }

    await timeSetupStep(
      timings,
      "ensure-home-layout",
      async () => {
        await ensureAccountHomeLayout(ctx.env, rootProcessIdentity, {
          cleanupGeneratedPromptContext: true,
        });
        await ensureAccountHomeLayout(ctx.env, bootstrapProcessIdentity, {
          cleanupGeneratedPromptContext: true,
        });
      },
    );
    checkpoint(true);

    const bootstrapResult = bootstrap;
    if (bootstrapResult && ctx.env.RIPGIT) {
      // handleSysBootstrap seeds the first setup user's skills; seed root explicitly too.
      const ripgit = new RipgitClient(ctx.env.RIPGIT);
      const sourceRepo = {
        owner: "root",
        repo: "gsv",
        branch: bootstrapResult.head ?? bootstrapResult.ref,
      };
      await timeSetupStep(
        timings,
        "seed-root-skills",
        () => seedRepoSkillsToHome(ripgit, sourceRepo, rootProcessIdentity),
      );
      checkpoint(true);
    }

    const processIdentity: ProcessIdentity = {
      uid,
      gid,
      gids: auth.resolveGids(username, gid),
      username,
      home,
      cwd: home,
    };

    await timeSetupStep(timings, "provision-personal-agent", async () => {
      await ensurePersonalAgent(ctx, processIdentity, agentName);
    });
    checkpoint(true);

    await timeSetupStep(timings, "provision-package-agents", async () => {
      await provisionEnabledPackagesForCaller(
        { ...ctx, identity: bootstrapIdentity },
        ctx.packages.list({ enabled: true }),
      );
    });
    checkpoint(true);

    const rootShadow = auth.getShadowByUsername("root");
    const rootLocked = rootShadow ? isLocked(rootShadow) : true;

    const result: SysSetupResult = {
      server: {
        version: ctx.serverVersion,
        release: SERVER_RELEASE,
      },
      user: processIdentity,
      rootLocked,
      bootstrap,
      nodeToken,
    };

    if (options.provisionUserKernels) {
      await timeSetupStep(
        timings,
        "provision-user-kernels",
        () => options.provisionUserKernels!(result),
      );
      checkpoint(true);
    }

    transitionSetupCommissioning(config, commissioning, "completed", true);

    console.info(
      `[sys.setup] user=${username} completed in ${Date.now() - startedAt}ms (${formatSetupTimings(timings)})`,
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      transitionSetupCommissioning(
        config,
        commissioning,
        "retryable",
        mutationStarted,
      );
    } catch (stateError) {
      console.error(
        `[sys.setup] failed to persist commissioning outcome: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
      );
    }
    console.error(
      `[sys.setup] user=${requestedUsername} failed after ${Date.now() - startedAt}ms (${formatSetupTimings(timings)}): ${message}`,
    );
    throw error;
  }
}
