import { hashPassword, isLocked, makeShadowEntry } from "../../auth/shadow";
import type { KernelContext } from "../context";
import type { PasswdEntry } from "../../auth/passwd";
import type { ProcessIdentity, SysSetupArgs, SysSetupResult, UserIdentity } from "@gsv/protocol/syscalls/system";
import { handleSysBootstrap } from "./bootstrap";
import { ensureHomeStorageLayout } from "../home-knowledge";
import { RipgitClient } from "../../fs";
import { seedRepoSkillsToHome } from "./skills-seed";
import { ensurePersonalAgent } from "../agents";
import { provisionEnabledPackagesForCaller } from "../package-agents";

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
  auth: KernelContext["auth"],
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
  const rawArgs = args as Record<string, unknown>;
  const requestedUsername = typeof rawArgs.username === "string" && rawArgs.username.trim().length > 0
    ? rawArgs.username.trim()
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
    if (ctx.env.RIPGIT && ctx.packages) {
      bootstrap = await timeSetupStep(
        timings,
        "bootstrap-system",
        () => handleSysBootstrap(rawArgs.bootstrap as SysSetupArgs["bootstrap"], {
          ...ctx,
          identity: bootstrapIdentity,
        } as KernelContext),
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
        await ensureHomeStorageLayout(ctx.env, rootProcessIdentity, {
          cleanupGeneratedPromptContext: true,
        });
        await ensureHomeStorageLayout(ctx.env, bootstrapProcessIdentity, {
          cleanupGeneratedPromptContext: true,
        });
      },
    );

    const bootstrapResult = bootstrap;
    if (bootstrapResult && ctx.env.RIPGIT) {
      await timeSetupStep(
        timings,
        "seed-root-skills",
        () => seedRepoSkillsToHome(
          new RipgitClient(ctx.env.RIPGIT!),
          {
            owner: "root",
            repo: "gsv",
            branch: bootstrapResult.head ?? bootstrapResult.ref,
          },
          rootProcessIdentity,
        ),
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

    await timeSetupStep(timings, "provision-package-agents", async () => {
      if (ctx.packages && typeof ctx.packages.list === "function") {
        await provisionEnabledPackagesForCaller(
          { ...ctx, identity: bootstrapIdentity } as KernelContext,
          ctx.packages.list({ enabled: true }),
        );
      }
    });

    const rootShadow = auth.getShadowByUsername("root");
    const rootLocked = rootShadow ? isLocked(rootShadow) : true;

    console.info(
      `[sys.setup] user=${username} completed in ${Date.now() - startedAt}ms (${formatSetupTimings(timings)})`,
    );

    return {
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
