/**
 * sys.connect handler.
 *
 * The first syscall any connection must make. Authenticates the user,
 * resolves identity + capabilities, registers devices/services,
 * and returns what the connection is allowed to do.
 *
 * Setup mode: if root's shadow entry is locked ("!"), any connection
 * is granted root (uid 0) without auth. This persists until root
 * sets a password via sys.passwd.
 */

import { authenticate, ensureBootstrapped } from "../auth";
import { isLocked, parseShadow, findByUsername as findShadowUser } from "../auth/shadow";
import type {
  ConnectArgs,
  ConnectResult,
  ConnectionIdentity,
  ProcessIdentity,
} from "../syscalls/system";
import { isValidCapability } from "./capabilities";
import type { KernelContext } from "./context";

export type ConnectOutcome =
  | { ok: true; identity: ConnectionIdentity; result: ConnectResult }
  | { ok: false; code: number; message: string };

export async function handleConnect(
  args: ConnectArgs,
  ctx: KernelContext,
): Promise<ConnectOutcome> {
  const { env, caps, devices, serverVersion } = ctx;
  const bucket = env.STORAGE;

  // Validate protocol
  if (args.protocol !== 1) {
    return { ok: false, code: 102, message: "Unsupported protocol version" };
  }

  const role = args.client?.role;
  if (!role || !["user", "driver", "service"].includes(role)) {
    return { ok: false, code: 103, message: "Invalid client role" };
  }

  // First-boot provisioning
  const { bootstrapped } = await ensureBootstrapped(bucket);
  if (bootstrapped) {
    caps.seed();
  }

  // Authentication
  const process = await resolveIdentity(args, bucket);
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

  // Build result
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

async function resolveIdentity(
  args: ConnectArgs,
  bucket: R2Bucket,
): Promise<IdentityOutcome> {
  if (!args.auth) {
    const setupMode = await isSetupMode(bucket);
    if (setupMode) {
      return {
        ok: true,
        identity: {
          uid: 0,
          gid: 0,
          gids: [0],
          username: "root",
          home: "/root",
        },
      };
    }
    return { ok: false, error: "Authentication required" };
  }

  const { username } = args.auth;
  const credential = args.auth.token ?? args.auth.password;

  if (!username) {
    return { ok: false, error: "Username required" };
  }

  if (!credential) {
    return { ok: false, error: "Password or token required" };
  }

  const result = await authenticate(bucket, username, credential);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, identity: result.identity };
}

async function isSetupMode(bucket: R2Bucket): Promise<boolean> {
  const obj = await bucket.get("/etc/shadow");
  if (!obj) return true;

  const raw = await obj.text();
  const entries = parseShadow(raw);
  const root = findShadowUser(entries, "root");
  if (!root) return true;

  return isLocked(root);
}

function buildSignalList(role: string): string[] {
  switch (role) {
    case "user":
      return ["chat.chunk", "chat.complete", "process.exit", "device.status", "channel.status"];
    case "driver":
      return ["device.status"];
    case "service":
      return ["channel.status"];
    default:
      return [];
  }
}
