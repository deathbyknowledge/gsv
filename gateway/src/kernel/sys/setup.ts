import { hashPassword, isLocked, makeShadowEntry } from "../../auth/shadow";
import type { KernelContext } from "../context";
import { SERVER_RELEASE } from "../../version";
import type { PasswdEntry } from "../../auth/passwd";
import {
  MANAGED_INFERENCE_MODEL,
  MANAGED_INFERENCE_PROVIDER,
  type ProcessIdentity,
  type ProvisionInstallationInput,
  type ProvisionInstallationResult,
  type SysSetupArgs,
  type SysSetupResult,
  type UserIdentity,
} from "@humansandmachines/gsv/protocol";
import { handleSysBootstrap } from "./bootstrap";
import { ensureAccountHomeLayout } from "../account-home";
import { RipgitClient } from "../../fs";
import { seedBuiltinSkillsToHome } from "./skills-seed";
import { ensurePersonalAgent } from "../agents";

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

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
  if (typeof raw.username !== "string" || !raw.username.trim()) {
    throw new Error("username is required");
  }
  // Validate the raw (untrimmed) value so padded names like " alice " are
  // rejected at the syscall boundary, not only in the web wizard.
  if (!USERNAME_RE.test(raw.username)) {
    throw new Error("username must match ^[a-z_][a-z0-9_-]{0,31}$");
  }
  const username = raw.username;

  const password = readRequiredString(raw.password, "password");
  if (password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  return { username, password };
}

function parseSetupAgentName(
  auth: KernelContext["auth"],
  value: unknown,
  username: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
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

export async function handleSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
): Promise<SysSetupResult> {
  const { auth, config } = ctx;
  const requestedUsername = typeof args.username === "string" && args.username.trim().length > 0
    ? args.username.trim()
    : "<unknown>";
  const startedAt = Date.now();
  const timings: SetupTiming[] = [];

  if (!auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const { username, password } = parseSetupIdentity(args);
  const ai = parseAiConfig(args);
  const timezone = parseTimezone(args);
  const node = parseNodeConfig(args);
  const rootPassword = readOptionalString((args as Record<string, unknown>).rootPassword);
  if (rootPassword && rootPassword.length < 8) {
    throw new Error("rootPassword must be at least 8 characters");
  }

  const passwdEntries = auth.getPasswdEntries();
  ensureSingleUserBootstrap(passwdEntries);
  if (auth.getPasswdByUsername(username)) {
    throw new Error(`User already exists: ${username}`);
  }
  const agentName = parseSetupAgentName(auth, (args as Record<string, unknown>).agentName, username);

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
  const bootstrapIdentity: UserIdentity = {
    role: "user",
    process: bootstrapProcessIdentity,
    capabilities: ["*"],
  };
  let bootstrap: SysSetupResult["bootstrap"];
  let nodeToken: SysSetupResult["nodeToken"];

  try {
    if (ctx.env.RIPGIT) {
      bootstrap = await timeSetupStep(
        timings,
        "bootstrap-system",
        () => handleSysBootstrap(undefined, {
          ...ctx,
          identity: bootstrapIdentity,
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

    if (node) {
      nodeToken = await timeSetupStep(timings, "issue-node-token", async () => {
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
      await ensurePersonalAgent(ctx, processIdentity, agentName);
    });

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

/**
 * Provision the first managed human without creating a second user-facing
 * password. The generated bootstrap password exists only for the duration of
 * this call and both human and root password entries are locked before the
 * installation becomes routable.
 *
 * A retry after partial setup resumes from the matching first account. This is
 * intentionally separate from public sys.setup, whose standalone contract
 * remains strict and password based.
 */
export async function handleManagedInstallationSetup(
  input: ProvisionInstallationInput,
  ctx: KernelContext,
): Promise<ProvisionInstallationResult> {
  const username = input.owner.username;
  const bootstrapPassword = randomBootstrapPassword();
  parseSetupIdentity({ username, password: bootstrapPassword });
  const agentName = parseManagedAgentName(ctx.auth, input.owner.agentName, username);
  const timezone = parseTimezone({
    username,
    password: bootstrapPassword,
    timezone: input.owner.timezone,
  });

  const existingHumans = ctx.auth.getPasswdEntries().filter((entry) => entry.uid >= 1000);
  const existing = ctx.auth.getPasswdByUsername(username);
  if (existingHumans.length === 0) {
    await handleSysSetup({
      username,
      password: bootstrapPassword,
      ...(agentName ? { agentName } : {}),
      ...(timezone ? { timezone } : {}),
    }, ctx);
  } else if (
    existingHumans.length !== 1
    || !existing
    || existingHumans[0].uid !== existing.uid
  ) {
    throw new Error("Managed installation is already initialized by another account");
  } else {
    await resumeManagedAccountSetup(ctx, existing, agentName);
    if (timezone !== undefined) {
      ctx.config.set("config/server/timezone", timezone);
    }
  }

  const user = ctx.auth.getPasswdByUsername(username);
  if (!user || user.uid < 1000) {
    throw new Error("Managed owner account was not created");
  }

  // Managed browser sessions authenticate with revocable opaque tokens. Local
  // passwords remain unavailable unless a future explicit product flow adds
  // one after recent platform authentication.
  ctx.auth.setShadow(makeShadowEntry(username, "!"));
  ctx.auth.setShadow(makeShadowEntry("root", "!"));
  ctx.config.set("config/ai/provider", MANAGED_INFERENCE_PROVIDER);
  ctx.config.set("config/ai/model", MANAGED_INFERENCE_MODEL);
  ctx.config.set("config/ai/api_key", "");
  ctx.config.set("config/ai/base_url", "");
  ctx.config.set("config/ai/provider_style", "auto");
  ctx.config.set("config/ai/transport_target", "gsv");
  // The standalone Workers AI fallback is not entitlement- or budget-aware.
  // Managed fallbacks must be added behind the broker instead.
  ctx.config.set("config/ai/fallback_model_profile", "");

  return {
    state: "active",
    installationId: input.installation.installationId,
    principalId: input.owner.principalId,
    localUid: user.uid,
    username: user.username,
    provisionVersion: input.provisionVersion,
  };
}

async function resumeManagedAccountSetup(
  ctx: KernelContext,
  user: PasswdEntry,
  agentName: string | undefined,
): Promise<void> {
  const processIdentity: ProcessIdentity = {
    uid: user.uid,
    gid: user.gid,
    gids: ctx.auth.resolveGids(user.username, user.gid),
    username: user.username,
    home: user.home,
    cwd: user.home,
  };
  await ensureAccountHomeLayout(ctx.env, {
    uid: 0,
    gid: 0,
    gids: [0],
    username: "root",
    home: "/root",
    cwd: "/root",
  }, {
    cleanupGeneratedPromptContext: true,
  });
  await ensureAccountHomeLayout(ctx.env, processIdentity, {
    cleanupGeneratedPromptContext: true,
  });
  await ensurePersonalAgent(ctx, processIdentity, agentName);
}

function randomBootstrapPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseManagedAgentName(
  auth: KernelContext["auth"],
  value: unknown,
  username: string,
): string | undefined {
  if (typeof value === "string") {
    const owner = auth.getPasswdByUsername(username);
    const existingAgentUid = owner ? auth.getPersonalAgentUid(owner.uid) : null;
    const existingAgent = existingAgentUid === null
      ? null
      : auth.getPasswdByUid(existingAgentUid);
    if (existingAgent?.username === value) {
      return value;
    }
  }
  return parseSetupAgentName(auth, value, username);
}
