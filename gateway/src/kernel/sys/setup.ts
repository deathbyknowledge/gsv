import { hashPassword, isLocked, makeShadowEntry } from "../../auth/shadow";
import { authorizeSetupToken } from "../../auth/setup-token";
import type { KernelContext } from "../context";
import { SERVER_RELEASE } from "../../version";
import type { PasswdEntry } from "../../auth/passwd";
import type { ProcessIdentity, SysSetupArgs, SysSetupResult, UserIdentity } from "@humansandmachines/gsv/protocol";
import { handleSysBootstrap } from "./bootstrap";
import { ensureAccountHomeLayout } from "../account-home";
import { RipgitClient } from "../../fs";
import { seedRepoSkillsToHome } from "./skills-seed";
import { ensureDefaultConversationExecutor, ensurePersonalAgent } from "../agents";
import { provisionEnabledPackagesForCaller } from "../package-agents";
import { assertSafeBootstrapArgs } from "./bootstrap-source";
import type { SetupRecoveryRecord } from "../setup-recovery";

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

type SetupTiming = {
  label: string;
  ms: number;
};

async function timeSetupStep<T>(
  timings: SetupTiming[],
  label: string,
  run: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = Date.now();
  try {
    signal?.throwIfAborted();
    const result = await run();
    signal?.throwIfAborted();
    return result;
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
  const username = readRequiredString(raw.username, "username");
  if (!USERNAME_RE.test(username)) {
    throw new Error(
      "username must match ^[a-z_][a-z0-9_-]{0,31}$",
    );
  }

  const password = readRequiredString(raw.password, "password");
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
  if (!USERNAME_RE.test(agentName)) {
    throw new Error("agentName must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  if (agentName === username) {
    throw new Error("agentName must be different from username");
  }
  return agentName;
}

function parseBootstrapConfig(value: unknown): SysSetupArgs["bootstrap"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bootstrap must be an object");
  }
  assertSafeBootstrapArgs(value);
  const raw = value as Record<string, unknown>;
  const remoteUrl = readOptionalString(raw.remoteUrl);
  const repo = readOptionalString(raw.repo);
  const ref = readOptionalString(raw.ref);
  if (remoteUrl === undefined && repo === undefined && ref === undefined) {
    return undefined;
  }
  return { remoteUrl, repo, ref };
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

async function setupPlanFingerprint(input: {
  username: string;
  rootPasswordPresent: boolean;
  agentName?: string;
  bootstrap?: SysSetupArgs["bootstrap"];
  ai: { provider?: string; model?: string; apiKey?: string };
  timezone?: string;
  node: ReturnType<typeof parseNodeConfig>;
}): Promise<string> {
  const canonical = JSON.stringify({
    version: 1,
    username: input.username,
    rootPasswordPresent: input.rootPasswordPresent,
    agentName: input.agentName ?? null,
    bootstrap: input.bootstrap
      ? {
          remoteUrl: input.bootstrap.remoteUrl ?? null,
          repo: input.bootstrap.repo ?? null,
          ref: input.bootstrap.ref ?? null,
        }
      : null,
    ai: {
      provider: input.ai.provider ?? null,
      model: input.ai.model ?? null,
      apiKeyPresent: input.ai.apiKey !== undefined,
    },
    timezone: input.timezone ?? null,
    node: input.node
      ? {
          deviceId: input.node.deviceId,
          label: input.node.label ?? null,
          // Expiry is issuance freshness, not tenant topology. Preserve its
          // presence while allowing an authenticated retry to move a now-stale
          // absolute timestamp forward.
          expiresAtPresent: input.node.expiresAt !== undefined,
        }
      : null,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRecoveryMatches(
  recovery: SetupRecoveryRecord,
  username: string,
  planFingerprint: string,
): void {
  if (recovery.username !== username || recovery.planFingerprint !== planFingerprint) {
    throw new Error("Setup recovery request does not match the interrupted setup");
  }
}

function assertAgentNameAvailable(
  auth: KernelContext["auth"],
  agentName: string | undefined,
): void {
  if (agentName && (auth.getPasswdByUsername(agentName) || auth.getGroupByName(agentName))) {
    throw new Error(`agentName is unavailable: ${agentName}`);
  }
}

export async function handleSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
): Promise<SysSetupResult> {
  const { auth, config } = ctx;
  const rawArgs = args as Record<string, unknown>;
  const requestedUsername = typeof rawArgs.username === "string" && rawArgs.username.trim().length > 0
    ? rawArgs.username.trim()
    : "<unknown>";
  const startedAt = Date.now();
  const timings: SetupTiming[] = [];
  const runSetupStep = <T>(label: string, run: () => T | Promise<T>): Promise<T> => (
    timeSetupStep(timings, label, run, ctx.requestSignal)
  );

  ctx.requestSignal?.throwIfAborted();
  const { username, password } = parseSetupIdentity(args);
  const bootstrapConfig = parseBootstrapConfig(rawArgs.bootstrap);
  const ai = parseAiConfig(args);
  const timezone = parseTimezone(args);
  const node = parseNodeConfig(args);
  const rootPassword = readOptionalString((args as Record<string, unknown>).rootPassword);
  if (rootPassword && rootPassword.length < 8) {
    throw new Error("rootPassword must be at least 8 characters");
  }

  const agentName = parseSetupAgentName(rawArgs.agentName, username);
  const planFingerprint = await setupPlanFingerprint({
    username,
    rootPasswordPresent: rootPassword !== undefined,
    agentName,
    bootstrap: bootstrapConfig,
    ai,
    timezone,
    node,
  });
  ctx.requestSignal?.throwIfAborted();
  let recovery = ctx.setupRecovery.current();
  if (!recovery && !auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  let uid: number;
  let gid: number;
  if (recovery) {
    assertRecoveryMatches(recovery, username, planFingerprint);
    const authenticated = await auth.authenticate(username, password);
    ctx.requestSignal?.throwIfAborted();
    if (
      !authenticated.ok
      || authenticated.identity.uid !== recovery.uid
      || authenticated.identity.gid !== recovery.gid
    ) {
      throw new Error("Setup recovery authentication failed");
    }
    uid = recovery.uid;
    gid = recovery.gid;
  } else {
    await authorizeSetupToken(
      ctx.env,
      rawArgs.setupToken,
      Date.now(),
      ctx.managedSetupTokenPolicy,
    );
    ctx.requestSignal?.throwIfAborted();

    const passwdEntries = auth.getPasswdEntries();
    ensureSingleUserBootstrap(passwdEntries);
    if (auth.getPasswdByUsername(username)) {
      throw new Error(`User already exists: ${username}`);
    }
    assertAgentNameAvailable(auth, agentName);

    uid = auth.nextUid();
    gid = uid;
    const [hashedPassword, rootHash] = await Promise.all([
      hashPassword(password),
      rootPassword ? hashPassword(rootPassword) : Promise.resolve(undefined),
    ]);
    ctx.requestSignal?.throwIfAborted();
    recovery = {
      username,
      uid,
      gid,
      planFingerprint,
      createdAt: Date.now(),
    };
    await runSetupStep("write-auth-state", () => {
      ctx.setupRecovery.start(recovery!, () => {
        ensureSingleUserBootstrap(auth.getPasswdEntries());
        if (auth.getPasswdByUsername(username)) {
          throw new Error(`User already exists: ${username}`);
        }
        assertAgentNameAvailable(auth, agentName);

        auth.addUser({
          username,
          uid,
          gid,
          gecos: username,
          home: `/home/${username}`,
          shell: "/bin/init",
        });
        auth.setShadow(makeShadowEntry(username, hashedPassword));

        if (!auth.getGroupByName(username) && !auth.getGroupByGid(gid)) {
          auth.addGroup({ name: username, gid, members: [] });
        }
        const usersGroup = auth.getGroupByName("users");
        if (usersGroup && !usersGroup.members.includes(username)) {
          auth.updateGroupMembers("users", [...usersGroup.members, username]);
        }
        if (!auth.setPasswordHash("root", rootHash ?? hashedPassword)) {
          throw new Error("Root account credentials are unavailable");
        }
      });
    });
  }

  // User Private Group (UPG): each user gets a unique primary group with gid = uid.
  // Shared capabilities still flow through supplementary membership in `users` (gid 100).
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
  let bootstrap: SysSetupResult["bootstrap"];
  let nodeToken: SysSetupResult["nodeToken"];

  try {
    if (ctx.env.RIPGIT) {
      bootstrap = await runSetupStep(
        "bootstrap-system",
        () => handleSysBootstrap(bootstrapConfig, {
          ...ctx,
          identity: bootstrapIdentity,
        }),
      );
    }

    await runSetupStep("write-system-config", () => {
      if (timezone !== undefined) {
        config.set("config/server/timezone", timezone);
      }
    });

    await runSetupStep("write-ai-config", () => {
      if (ai.provider !== undefined) {
        config.set("config/ai/provider", ai.provider);
      }
      if (ai.model !== undefined) {
        config.set("config/ai/model", ai.model);
      }
      if (ai.apiKey !== undefined) {
        config.set("config/ai/api_key", ai.apiKey);
      }
    });

    await runSetupStep(
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

    const bootstrapResult = bootstrap;
    if (bootstrapResult && ctx.env.RIPGIT) {
      // handleSysBootstrap seeds the first setup user's skills; seed root explicitly too.
      const ripgit = new RipgitClient(ctx.env.RIPGIT);
      const sourceRepo = {
        owner: "root",
        repo: "gsv",
        branch: bootstrapResult.head ?? bootstrapResult.ref,
      };
      await runSetupStep(
        "seed-root-skills",
        () => seedRepoSkillsToHome(ripgit, sourceRepo, rootProcessIdentity),
      );
    }

    const processIdentity: ProcessIdentity = {
      uid,
      gid,
      gids: auth.resolveGids(username, gid),
      username,
      home,
      cwd: home,
    };

    await runSetupStep("provision-personal-agent", async () => {
      await ensurePersonalAgent(ctx, processIdentity, agentName);
    });

    await runSetupStep("provision-package-agents", async () => {
      await provisionEnabledPackagesForCaller(
        { ...ctx, identity: bootstrapIdentity },
        ctx.packages.list({ enabled: true }),
      );
    });

    await runSetupStep("provision-default-conversation", () => (
      ensureDefaultConversationExecutor(ctx, processIdentity)
    ));

    const preparedNodeToken = node
      ? await runSetupStep("prepare-node-token", () => auth.prepareToken({
          uid,
          kind: "node",
          label: node.label ?? `node:${node.deviceId}`,
          allowedRole: "driver",
          allowedDeviceId: node.deviceId,
          expiresAt: node.expiresAt,
        }))
      : undefined;
    nodeToken = await runSetupStep("commit-setup", () => (
      ctx.setupRecovery.finish(recovery!, () => {
        if (!preparedNodeToken) return undefined;
        const issued = auth.persistPreparedToken(preparedNodeToken);
        return {
          tokenId: issued.tokenId,
          token: issued.token,
          tokenPrefix: issued.tokenPrefix,
          uid: issued.uid,
          kind: "node" as const,
          label: issued.label,
          allowedRole: "driver" as const,
          allowedDeviceId: issued.allowedDeviceId,
          createdAt: issued.createdAt,
          expiresAt: issued.expiresAt,
        };
      })
    ));

    const rootShadow = auth.getShadowByUsername("root");
    const rootLocked = rootShadow ? isLocked(rootShadow) : true;

    console.info(
      `[sys.setup] user=${username} completed in ${Date.now() - startedAt}ms (${formatSetupTimings(timings)})`,
    );

    return {
      server: {
        version: ctx.serverVersion,
        release: SERVER_RELEASE,
      },
      user: processIdentity,
      rootLocked,
      bootstrap,
      nodeToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.setup] user=${requestedUsername} failed after ${Date.now() - startedAt}ms (${formatSetupTimings(timings)}): ${message}`,
    );
    throw error;
  }
}
