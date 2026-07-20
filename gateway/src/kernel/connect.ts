/**
 * sys.connect handler.
 *
 * The first syscall any connection must make. Authenticates the user,
 * resolves identity + capabilities, registers devices/services,
 * and returns what the connection is allowed to do.
 *
 * Auth data lives in kernel SQLite (AuthStore), not R2.
 * During setup mode, sys.connect is rejected with structured details
 * pointing the caller to sys.setup.
 */

import type {
  ConnectArgs,
  ConnectResult,
  ConnectionIdentity,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { AuthenticatedCredential, AuthTokenRole } from "./auth-store";
import type { CapabilityStore } from "./capabilities";
import { isValidCapability } from "./capabilities";
import type { KernelContext } from "./context";
import { SERVER_RELEASE } from "../version";
import { provisionR2Directory } from "../fs/backends/r2";
import { ensureAccountHomeLayout } from "./account-home";
import { ensurePublicAssetStorageLayout } from "../public-assets";
import { USER_CONNECTION_SIGNALS } from "./user-signals";
import { UNAVAILABLE_LOGIN_SOURCE_SCOPE } from "./login-source";
import { isSetupCommissioningPending } from "./sys/setup";

export type ConnectOutcome =
  | {
      ok: true;
      identity: ConnectionIdentity;
      credential: AuthenticatedCredential;
      result: ConnectResult;
    }
  | { ok: false; code: number; message: string; details?: unknown };

export const SETUP_REQUIRED_ERROR_CODE = 425;

const DRIVER_CONNECTION_CAPABILITIES: string[] = [];
const SERVICE_CAPABILITY_GIDS = [102];

export function setupRequiredDetails(): { setupMode: true; next: "sys.setup" } {
  return { setupMode: true, next: "sys.setup" };
}

export async function ensureKernelBootstrapped(ctx: KernelContext): Promise<void> {
  await ctx.auth.bootstrap();
  ctx.caps.seed();
  migrateUserPrivateGroups(ctx);
  await ensurePublicAssetStorageLayout(ctx.env);
  await provisionR2Directory(ctx.env.STORAGE, "/tmp", { uid: 0, gid: 0 }, "777");
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
}

/**
 * Migrate legacy human accounts that were created before User Private Groups (UPG)
 * onto their own private primary group (gid = uid), while keeping `users` (gid 100)
 * membership so shared capabilities are preserved.
 *
 * Idempotent: accounts already off gid 100 (migrated humans and agent accounts,
 * which are created with gid = uid from the start) are skipped.
 */
function migrateUserPrivateGroups(ctx: KernelContext): void {
  const { auth } = ctx;
  for (const entry of auth.getPasswdEntries()) {
    if (entry.uid < 1000) continue;
    if (entry.gid !== 100) continue;

    if (!auth.getGroupByName(entry.username) && !auth.getGroupByGid(entry.uid)) {
      auth.addGroup({ name: entry.username, gid: entry.uid, members: [] });
    }
    auth.updateUser(entry.username, { gid: entry.uid });

    const usersGroup = auth.getGroupByName("users");
    if (usersGroup && !usersGroup.members.includes(entry.username)) {
      auth.updateGroupMembers("users", [...usersGroup.members, entry.username]);
    }
  }
}

export async function handleConnect(
  args: ConnectArgs,
  ctx: KernelContext,
): Promise<ConnectOutcome> {
  const { auth, caps, devices, serverVersion } = ctx;
  if (!ctx.connection) {
    throw new Error("sys.connect requires an active connection");
  }

  if (args.protocol !== 2) {
    return { ok: false, code: 102, message: "Unsupported protocol version" };
  }

  const role = args.client?.role;
  if (!role || !["user", "driver", "service"].includes(role)) {
    return { ok: false, code: 103, message: "Invalid client role" };
  }

  // Commissioning exists only on the master. User Kernels are provisioned by
  // an authenticated master RPC and must never bootstrap root themselves.
  if (ctx.kernelKind === "master") {
    await ensureKernelBootstrapped(ctx);
  }

  if (
    ctx.kernelKind === "master"
    && (auth.isSetupMode() || isSetupCommissioningPending(ctx.config))
  ) {
    return {
      ok: false,
      code: SETUP_REQUIRED_ERROR_CODE,
      message: "Setup required",
      details: setupRequiredDetails(),
    };
  }

  // Authentication
  const process = ctx.authenticateConnection
    ? await ctx.authenticateConnection(args)
    : await authenticateConnectionIdentity(args, ctx.auth, ctx.loginSourceScope);
  if (!process.ok) {
    return { ok: false, code: 401, message: process.error };
  }
  const identity = process.identity;

  const capabilities = "capabilities" in process && Array.isArray(process.capabilities)
    ? process.capabilities.filter((capability): capability is string => typeof capability === "string")
    : resolveConnectionCapabilities(role, identity, caps);

  // Build ConnectionIdentity based on role
  let connectionIdentity: ConnectionIdentity;

  switch (role) {
    case "user": {
      connectionIdentity = {
        role: "user",
        process: identity,
        capabilities,
      };
      break;
    }

    case "driver": {
      if (!args.driver?.implements || args.driver.implements.length === 0) {
        return { ok: false, code: 103, message: "Driver role requires implements list" };
      }

      for (const pattern of args.driver.implements) {
        if (!isValidCapability(pattern)) {
          return { ok: false, code: 103, message: `Invalid implements pattern: ${pattern}` };
        }
      }

      const deviceId = args.client.id;
      const regResult = devices.register(
        deviceId,
        identity.uid,
        identity.gid,
        args.driver.implements,
        args.client.platform,
        args.client.version,
      );

      if (!regResult.ok) {
        return { ok: false, code: 103, message: regResult.error! };
      }

      connectionIdentity = {
        role: "driver",
        process: identity,
        capabilities,
        device: deviceId,
        implements: args.driver.implements,
      };
      break;
    }

    case "service": {
      const channel = args.client.channel;
      if (!channel) {
        return { ok: false, code: 103, message: "Service role requires channel field" };
      }

      connectionIdentity = {
        role: "service",
        process: identity,
        capabilities,
        channel,
      };
      break;
    }

    default:
      return { ok: false, code: 103, message: "Invalid client role" };
  }

  const result: ConnectResult = {
    protocol: 2,
    server: {
      version: serverVersion,
      release: SERVER_RELEASE,
      connectionId: ctx.connection.id,
    },
    identity: connectionIdentity,
    syscalls: capabilities,
    signals: buildSignalList(role),
  };

  return {
    ok: true,
    identity: connectionIdentity,
    credential: process.credential,
    result,
  };
}

export type IdentityOutcome =
  | { ok: true; identity: ProcessIdentity; credential: AuthenticatedCredential }
  | { ok: false; error: string };

function withDefaultProcessContext(identity: {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
}): ProcessIdentity {
  return {
    ...identity,
    cwd: identity.home,
  };
}

function resolveConnectionCapabilities(
  role: ConnectArgs["client"]["role"],
  identity: ProcessIdentity,
  caps: CapabilityStore,
): string[] {
  switch (role) {
    case "user":
      return caps.resolve(identity.gids);
    case "driver":
      return [...DRIVER_CONNECTION_CAPABILITIES];
    case "service":
      return caps.resolve(SERVICE_CAPABILITY_GIDS);
  }
}

export async function authenticateConnectionIdentity(
  args: ConnectArgs,
  auth: KernelContext["auth"],
  loginSourceScope: KernelContext["loginSourceScope"],
): Promise<IdentityOutcome> {
  const role = args.client.role;
  const sourceScope = loginSourceScope ?? UNAVAILABLE_LOGIN_SOURCE_SCOPE;

  if (!args.auth) {
    return { ok: false, error: "Authentication required" };
  }

  const { username } = args.auth;
  if (!username) return { ok: false, error: "Username required" };
  const hasToken = !!args.auth.token;
  const hasPassword = !!args.auth.password;
  if (hasToken && hasPassword) return { ok: false, error: "Provide either password or token" };

  if (role === "driver" || role === "service") {
    if (!hasToken) {
      return { ok: false, error: "Token required for machine connections" };
    }
    const machineRole = role as AuthTokenRole;

    const result = await auth.authenticateToken(username, args.auth.token!, sourceScope, {
      role: machineRole,
      deviceId: role === "driver" ? args.client.id : undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      identity: withDefaultProcessContext(result.identity),
      credential: result.credential,
    };
  }

  if (hasToken) {
    const result = await auth.authenticateToken(username, args.auth.token!, sourceScope, {
      role: "user",
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      identity: withDefaultProcessContext(result.identity),
      credential: result.credential,
    };
  }

  if (!hasPassword) return { ok: false, error: "Password or token required" };
  const result = await auth.authenticate(username, args.auth.password!, sourceScope);
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    identity: withDefaultProcessContext(result.identity),
    credential: result.credential,
  };
}

function buildSignalList(role: string): string[] {
  switch (role) {
    case "user":
      return [...USER_CONNECTION_SIGNALS];
    case "driver":
      return ["device.status", "device.pong"];
    default:
      return [];
  }
}
