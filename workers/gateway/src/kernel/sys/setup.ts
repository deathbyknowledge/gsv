import { hashPassword, isLocked, makeShadowEntry } from "../../auth/shadow";
import type { KernelContext } from "../context";
import { kernelPeerContext } from "../peer";
import { SERVER_RELEASE } from "../../version";
import type { PasswdEntry } from "../../auth/passwd";
import {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PROVIDER,
  type AiModelStack,
  type ProcessIdentity,
  type SysSetupArgs,
  type SysSetupResult,
} from "@humansandmachines/gsv/protocol";
import { handleSysBootstrap } from "./bootstrap";
import { ensureAccountHomeLayout } from "../account-home";
import { RipgitClient } from "../../fs";
import { seedBuiltinSkillsToHome } from "./skills-seed";
import { gsvInferenceFeaturesFromEnv } from "../../inference/gsv-provider";
import { ensurePersonalController } from "../personal-controller";
import { getConversationById } from "../../shared/utils";
import {
  aiModelApiKeyConfigKey,
  userAiModelsConfigKey,
} from "../ai-model-stack";

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

type SetupTiming = {
  label: string;
  ms: number;
};

type SetupIdentity = {
  username: string;
  password: string;
};

type SetupMachineConfig = {
  peerId: string;
  label?: string;
  expiresAt?: number;
};

async function ensurePersonalConversation(
  ownerUid: number,
  ctx: KernelContext,
  preferredAgentName?: string,
): Promise<void> {
  const pid = await ensurePersonalController(ownerUid, ctx, preferredAgentName);
  const conversation = ctx.conversations.ensureShip(ownerUid, pid);
  await getConversationById(ctx.installationId, conversation.id).initialize({
    ownerUid,
    kind: "ship",
  });
}

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

function readRequiredString(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalFutureTimestamp(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new Error("machine.expiresAt must be a unix timestamp in milliseconds");
  }
  const ts = Math.floor(value);
  if (ts <= Date.now()) {
    throw new Error("machine.expiresAt must be in the future");
  }
  return ts;
}

function ensureSingleUserBootstrap(passwd: PasswdEntry[]): void {
  if (passwd.some((entry) => entry.uid >= 1000)) {
    throw new Error("System already initialized");
  }
}

function parseSetupIdentity(args: SysSetupArgs): SetupIdentity {
  if (!args.username.trim()) {
    throw new Error("username is required");
  }
  // Validate the raw (untrimmed) value so padded names like " alice " are
  // rejected at the syscall boundary, not only in the web wizard.
  if (!USERNAME_RE.test(args.username)) {
    throw new Error("username must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  const username = args.username;

  const password = readRequiredString(args.password, "password");
  if (password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  return { username, password };
}

function parseSetupAgentName(
  auth: KernelContext["auth"],
  value: string | undefined,
  username: string,
): string | undefined {
  if (!value?.trim()) return undefined;
  // Validate the raw (untrimmed) value so padded names are rejected here too.
  if (!USERNAME_RE.test(value)) {
    throw new Error("agentName must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  const agentName = value;
  if (agentName === username) {
    throw new Error("agentName must be different from username");
  }
  if (auth.getPasswdByUsername(agentName) || auth.getGroupByName(agentName)) {
    throw new Error(`agentName is unavailable: ${agentName}`);
  }
  return agentName;
}

type SetupAiConfig = {
  provider?: string;
  model?: string;
  apiKey?: string;
};

function parseAiConfig(args: SysSetupArgs): SetupAiConfig {
  if (!args.ai) {
    return {};
  }
  return {
    provider: readOptionalString(args.ai.provider),
    model: readOptionalString(args.ai.model),
    apiKey: args.ai.apiKey,
  };
}

function resolveSetupAiConfig(
  ai: SetupAiConfig,
  managedInferenceAvailable: boolean,
): SetupAiConfig {
  if (ai.provider === GSV_INFERENCE_PROVIDER) {
    if (!managedInferenceAvailable) {
      throw new Error("GSV included inference is not available");
    }
    if (ai.model !== undefined && ai.model !== GSV_INFERENCE_MODEL) {
      throw new Error("GSV included inference does not accept a model selection");
    }
    if (ai.apiKey?.trim()) {
      throw new Error("GSV included inference does not accept an API key");
    }
    return {
      provider: GSV_INFERENCE_PROVIDER,
      model: GSV_INFERENCE_MODEL,
    };
  }
  if (
    managedInferenceAvailable
    && ai.provider === undefined
    && ai.model === undefined
    && ai.apiKey === undefined
  ) {
    return {
      provider: GSV_INFERENCE_PROVIDER,
      model: GSV_INFERENCE_MODEL,
    };
  }
  return ai;
}

function setupAiModelStack(ai: SetupAiConfig): AiModelStack | null {
  if (ai.provider === undefined && ai.model === undefined && ai.apiKey === undefined) {
    return null;
  }
  if (!ai.provider || !ai.model) {
    throw new Error("AI provider and model must be configured together");
  }
  return {
    version: 1,
    models: [{
      id: "setup-primary",
      name: ai.provider === GSV_INFERENCE_PROVIDER ? "GSV Included" : ai.model,
      provider: ai.provider,
      model: ai.model,
    }],
  };
}

function parseTimezone(args: SysSetupArgs): string | undefined {
  const timezone = readOptionalString(args.timezone);
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

function parseMachineConfig(args: SysSetupArgs): SetupMachineConfig | null {
  if (!args.machine) {
    return null;
  }
  const peerId = readRequiredString(args.machine.peerId, "machine.peerId");
  return {
    peerId,
    label: readOptionalString(args.machine.label),
    expiresAt: parseOptionalFutureTimestamp(args.machine.expiresAt),
  };
}

function setupServerBuild(
  ctx: KernelContext,
  features: string[],
): SysSetupResult["server"] {
  const server: SysSetupResult["server"] = {
    version: ctx.serverVersion,
    release: SERVER_RELEASE,
  };
  if (features.length > 0) {
    server.features = features;
  }
  return server;
}

export async function handleSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
): Promise<SysSetupResult> {
  const { auth, config } = ctx;
  const requestedUsername = args.username.trim().length > 0
    ? args.username.trim()
    : "<unknown>";
  const startedAt = Date.now();
  const timings: SetupTiming[] = [];

  if (!auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const { username, password } = parseSetupIdentity(args);
  const serverFeatures = gsvInferenceFeaturesFromEnv(ctx.env);
  const managedInferenceAvailable = serverFeatures.includes(GSV_INFERENCE_FEATURE);
  const ai = resolveSetupAiConfig(
    parseAiConfig(args),
    managedInferenceAvailable,
  );
  const aiModels = setupAiModelStack(ai);
  const timezone = parseTimezone(args);
  const machine = parseMachineConfig(args);
  const rootPassword = readOptionalString(args.rootPassword);
  if (rootPassword && rootPassword.length < 8) {
    throw new Error("rootPassword must be at least 8 characters");
  }

  const passwdEntries = auth.getPasswdEntries();
  ensureSingleUserBootstrap(passwdEntries);
  if (auth.getPasswdByUsername(username)) {
    throw new Error(`User already exists: ${username}`);
  }
  const agentName = parseSetupAgentName(auth, args.agentName, username);

  const uid = auth.nextUid();
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
  const bootstrapPeer = kernelPeerContext({
    installationId: ctx.installationId,
    identity: bootstrapProcessIdentity,
    calls: ["*"],
  });
  let bootstrap: SysSetupResult["bootstrap"];
  let machineToken: SysSetupResult["machineToken"];

  try {
    if (ctx.env.RIPGIT) {
      bootstrap = await timeSetupStep(
        timings,
        "bootstrap-system",
        () => handleSysBootstrap(undefined, {
          ...ctx,
          peer: bootstrapPeer,
        }),
      );
    }

    await timeSetupStep(timings, "write-auth-state", async () => {
      auth.addUser({
        username,
        uid,
        gid,
        gecos: username,
        home,
        shell: "/bin/init",
      });

      const hashedPassword = await hashPassword(password);
      auth.setShadow(makeShadowEntry(username, hashedPassword));

      // Private primary group (gid = uid) owned by this user.
      if (!auth.getGroupByName(username) && !auth.getGroupByGid(gid)) {
        auth.addGroup({ name: username, gid, members: [] });
      }

      const usersGroup = auth.getGroupByName("users");
      if (usersGroup && !usersGroup.members.includes(username)) {
        auth.updateGroupMembers("users", [...usersGroup.members, username]);
      }

      if (rootPassword) {
        const rootHash = await hashPassword(rootPassword);
        await auth.setPassword("root", rootHash);
      } else {
        await auth.setPassword("root", hashedPassword);
      }

    });

    await timeSetupStep(timings, "write-system-config", () => {
      if (timezone !== undefined) {
        config.set("config/server/timezone", timezone);
      }
    });

    await timeSetupStep(timings, "write-ai-config", () => {
      if (aiModels) {
        const stackKey = userAiModelsConfigKey(uid);
        config.set(stackKey, JSON.stringify(aiModels));
        if (ai.apiKey !== undefined) {
          config.set(
            aiModelApiKeyConfigKey(stackKey, aiModels.models[0].id),
            ai.apiKey,
          );
        }
      }
    });

    if (machine) {
      machineToken = await timeSetupStep(timings, "issue-machine-token", async () => {
        const issued = await auth.issueToken({
          uid,
          kind: "machine",
          label: machine.label ?? `machine:${machine.peerId}`,
          peerId: machine.peerId,
          expiresAt: machine.expiresAt,
        });
        return {
          tokenId: issued.tokenId,
          token: issued.token,
          tokenPrefix: issued.tokenPrefix,
          uid: issued.uid,
          kind: "machine",
          label: issued.label,
          peerId: machine.peerId,
          createdAt: issued.createdAt,
          expiresAt: issued.expiresAt,
        };
      });
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

    if (bootstrap && ctx.env.RIPGIT) {
      // handleSysBootstrap seeds the first setup user's skills; seed root explicitly too.
      const ripgit = new RipgitClient(ctx.env.RIPGIT);
      await timeSetupStep(
        timings,
        "seed-root-skills",
        () => seedBuiltinSkillsToHome(ripgit, rootProcessIdentity),
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

    await timeSetupStep(timings, "provision-personal-agent", async () => {
      await ensurePersonalConversation(uid, ctx, agentName);
    });

    const rootShadow = auth.getShadowByUsername("root");
    const rootLocked = rootShadow ? isLocked(rootShadow) : true;

    console.info(
      `[sys.setup] user=${username} completed in ${Date.now() - startedAt}ms (${formatSetupTimings(timings)})`,
    );

    return {
      server: setupServerBuild(ctx, serverFeatures),
      user: processIdentity,
      rootLocked,
      bootstrap,
      machineToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sys.setup] user=${requestedUsername} failed after ${Date.now() - startedAt}ms (${formatSetupTimings(timings)}): ${message}`,
    );
    throw error;
  }
}

export async function recoverCompletedSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
): Promise<SysSetupResult> {
  const { username, password } = parseSetupIdentity(args);
  const humans = ctx.auth.getPasswdEntries().filter(
    (entry) => entry.uid >= 1000 && !ctx.auth.isPersonalAgentUid(entry.uid),
  );
  const user = ctx.auth.getPasswdByUsername(username);
  if (humans.length !== 1 || !user || humans[0]?.uid !== user.uid) {
    throw new Error("System already initialized");
  }
  const authenticated = await ctx.auth.authenticate(username, password);
  if (!authenticated.ok || authenticated.identity.uid !== user.uid) {
    throw new Error("Installation setup credentials do not match");
  }

  const preferredAgentName = ctx.auth.getPersonalAgentUid(user.uid) === null
    ? parseSetupAgentName(ctx.auth, args.agentName, username)
    : undefined;
  await ensurePersonalConversation(user.uid, ctx, preferredAgentName);

  const machine = parseMachineConfig(args);
  let machineToken: SysSetupResult["machineToken"];
  if (machine) {
    for (const token of ctx.auth.listTokens(user.uid)) {
      if (
        token.kind === "machine"
        && token.peerId === machine.peerId
        && token.revokedAt === null
      ) {
        ctx.auth.revokeToken(token.tokenId, "setup retry", user.uid);
      }
    }
    const issued = await ctx.auth.issueToken({
      uid: user.uid,
      kind: "machine",
      label: machine.label ?? `machine:${machine.peerId}`,
      peerId: machine.peerId,
      expiresAt: machine.expiresAt,
    });
    machineToken = {
      tokenId: issued.tokenId,
      token: issued.token,
      tokenPrefix: issued.tokenPrefix,
      uid: issued.uid,
      kind: "machine",
      label: issued.label,
      peerId: machine.peerId,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
    };
  }

  const rootShadow = ctx.auth.getShadowByUsername("root");
  const serverFeatures = gsvInferenceFeaturesFromEnv(ctx.env);
  return {
    server: setupServerBuild(ctx, serverFeatures),
    user: {
      ...authenticated.identity,
      cwd: authenticated.identity.home,
    },
    rootLocked: rootShadow ? isLocked(rootShadow) : true,
    machineToken,
  };
}
