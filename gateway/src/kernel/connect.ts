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
} from "@gsv/protocol/syscalls/system";
import type { AuthTokenRole } from "./auth-store";
import { isValidCapability } from "./capabilities";
import type { KernelContext } from "./context";
import { ensureHomeStorageLayout } from "./home-knowledge";

export type ConnectOutcome =
  | { ok: true; identity: ConnectionIdentity; result: ConnectResult }
  | { ok: false; code: number; message: string; details?: unknown };

export const SETUP_REQUIRED_ERROR_CODE = 425;

export function setupRequiredDetails(): { setupMode: true; next: "sys.setup" } {
  return { setupMode: true, next: "sys.setup" };
}

export async function ensureKernelBootstrapped(ctx: KernelContext): Promise<void> {
  await ctx.auth.bootstrap();
  ctx.caps.seed();
  await ensureHomeStorageLayout(ctx.env, {
    uid: 0,
    gid: 0,
    gids: [0],
    username: "root",
    home: "/root",
    cwd: "/root",
    workspaceId: null,
  });
}

export async function handleConnect(
  args: ConnectArgs,
  ctx: KernelContext,
): Promise<ConnectOutcome> {
  const { auth, caps, devices, serverVersion } = ctx;

  if (args.protocol !== 1) {
    return { ok: false, code: 102, message: "Unsupported protocol version" };
  }

  const role = args.client?.role;
  if (!role || !["user", "driver", "service"].includes(role)) {
    return { ok: false, code: 103, message: "Invalid client role" };
  }

  // First-boot provisioning (SQLite, no R2)
  await ensureKernelBootstrapped(ctx);

  if (auth.isSetupMode()) {
    return {
      ok: false,
      code: SETUP_REQUIRED_ERROR_CODE,
      message: "Setup required",
      details: setupRequiredDetails(),
    };
  }

  // Authentication
  const process = await resolveIdentity(args, ctx);
  if (!process.ok) {
    return { ok: false, code: 401, message: process.error };
  }
  const identity = process.identity;

  // Resolve capabilities
  const capabilities = caps.resolve(identity.gids);

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
    protocol: 1,
    server: {
      version: serverVersion,
      connectionId: ctx.connection.id,
    },
    identity: connectionIdentity,
    syscalls: capabilities,
    signals: buildSignalList(role),
  };

  return { ok: true, identity: connectionIdentity, result };
}

type IdentityOutcome =
  | { ok: true; identity: ProcessIdentity }
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
    workspaceId: null,
  };
}

async function resolveIdentity(
  args: ConnectArgs,
  ctx: KernelContext,
): Promise<IdentityOutcome> {
  const { auth } = ctx;
  const role = args.client.role;

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

    const result = await auth.authenticateToken(username, args.auth.token!, {
      role: machineRole,
      deviceId: role === "driver" ? args.client.id : undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, identity: withDefaultProcessContext(result.identity) };
  }

  if (hasToken) {
    const result = await auth.authenticateToken(username, args.auth.token!, {
      role: "user",
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, identity: withDefaultProcessContext(result.identity) };
  }

  if (!hasPassword) return { ok: false, error: "Password or token required" };
  const result = await auth.authenticate(username, args.auth.password!);
  if (!result.ok) return { ok: false, error: result.error };

  return { ok: true, identity: withDefaultProcessContext(result.identity) };
}

function buildSignalList(role: string): string[] {
  switch (role) {
    case "user":
      return ["chat.text", "chat.tool_call", "chat.tool_result", "chat.hil", "chat.complete", "process.exit", "device.status", "adapter.status", "pkg.changed"];
    case "driver":
      return ["device.status"];
    case "service":
      return ["adapter.status"];
    default:
      return [];
  }
}
