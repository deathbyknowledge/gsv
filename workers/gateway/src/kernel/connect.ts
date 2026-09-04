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
  ConnectedPeer,
  ConnectArgs,
  ConnectResult,
  JsonValue,
  PeerPrincipalKind,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { CapabilityStore } from "./capabilities";
import { isValidCapability } from "./capabilities";
import type { KernelContext } from "./context";
import type { TargetRecord } from "./target-registry";
import { SERVER_RELEASE } from "../version";
import { ensureAccountHomeLayout } from "./account-home";
import { ensurePublicAssetStorageLayout } from "../public-assets";
import { USER_CONNECTION_SIGNALS } from "./user-signals";
import { gsvInferenceFeaturesFromEnv } from "../inference/gsv-provider";

export type ConnectOutcome =
  | {
      ok: true;
      peer: ConnectedPeer;
      result: ConnectResult;
      newMachine?: TargetRecord;
    }
  | { ok: false; code: number; message: string; details?: JsonValue };

export const SETUP_REQUIRED_ERROR_CODE = 425;
type SetupRequiredDetails = { setupMode: true; next: "sys.setup" };

export const PROTOCOL_VERSION = 4;
const INSTALLER_URL = "https://install.gsv.space";
const MACHINE_CONNECTION_CAPABILITIES: string[] = [];
const SERVICE_CAPABILITY_GIDS = [102];

export function setupRequiredDetails(): SetupRequiredDetails {
  return { setupMode: true, next: "sys.setup" };
}

export async function ensureKernelBootstrapped(ctx: KernelContext): Promise<void> {
  await ctx.auth.bootstrap();
  ctx.caps.seed();
  migrateUserPrivateGroups(ctx);
  await ensurePublicAssetStorageLayout(ctx.env);
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
  const { auth, caps, targets, serverVersion } = ctx;
  if (!ctx.connection) {
    throw new Error("sys.connect requires an active connection");
  }

  if (args.protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 102,
      message: args.protocol < PROTOCOL_VERSION
        ? `This client speaks protocol ${args.protocol}; the gateway requires protocol ${PROTOCOL_VERSION}. Update the client with ${INSTALLER_URL}.`
        : `This client speaks protocol ${args.protocol}; the gateway only supports protocol ${PROTOCOL_VERSION}. Redeploy the gateway.`,
      details: {
        requestedProtocol: args.protocol,
        supportedProtocol: PROTOCOL_VERSION,
        serverVersion: ctx.serverVersion,
        installer: INSTALLER_URL,
      },
    };
  }

  const peerId = args.peer?.id?.trim();
  if (!peerId) {
    return { ok: false, code: 103, message: "Peer id is required" };
  }

  // First-boot provisioning (SQLite, no R2)
  await ensureKernelBootstrapped(ctx);

  if (auth.isSetupMode()) {
    if (ctx.env.INSTALLATION_DIRECTORY) {
      return {
        ok: false,
        code: 503,
        message: "Managed installation provisioning is incomplete",
      };
    }
    return {
      ok: false,
      code: SETUP_REQUIRED_ERROR_CODE,
      message: "Setup required",
      details: setupRequiredDetails(),
    };
  }

  // Authentication
  const authenticated = await authenticatePeer(args, ctx);
  if (!authenticated.ok) {
    return { ok: false, code: 401, message: authenticated.error };
  }
  const { identity, principalKind } = authenticated;
  const implementsList = [...new Set(args.peer.implements ?? [])];
  if (principalKind === "machine" && implementsList.length === 0) {
    return { ok: false, code: 103, message: "Machine peers require an implements list" };
  }
  for (const pattern of implementsList) {
    if (!isValidCapability(pattern)) {
      return { ok: false, code: 103, message: `Invalid implements pattern: ${pattern}` };
    }
  }

  const capabilities = resolvePeerCalls(principalKind, identity, caps);
  const signals = buildSignalList(principalKind);
  let newMachine: TargetRecord | undefined;

  if (implementsList.length > 0) {
    const registered = targets.register(
      peerId,
      identity.uid,
      identity.gid,
      implementsList,
      args.peer.platform,
      args.peer.version,
    );
    if (!registered.ok) {
      return { ok: false, code: 103, message: registered.error };
    }
    if (principalKind === "machine" && registered.created) {
      newMachine = registered.device;
    }
  }

  const peer: ConnectedPeer = {
    id: peerId,
    sessionId: ctx.connection.id,
    principal: { kind: principalKind, account: identity },
    grant: {
      calls: capabilities,
      signals,
      implements: implementsList,
    },
  };

  const serverFeatures = gsvInferenceFeaturesFromEnv(ctx.env);
  const result: ConnectResult = {
    protocol: PROTOCOL_VERSION,
    server: {
      version: serverVersion,
      release: SERVER_RELEASE,
      connectionId: ctx.connection.id,
    },
    peer,
  };
  if (serverFeatures.length > 0) {
    result.server.features = serverFeatures;
  }

  return { ok: true, peer, result, ...(newMachine ? { newMachine } : undefined) };
}

type PeerAuthenticationOutcome =
  | {
      ok: true;
      identity: ProcessIdentity;
      principalKind: PeerPrincipalKind;
    }
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

function resolvePeerCalls(
  kind: PeerPrincipalKind,
  identity: ProcessIdentity,
  caps: CapabilityStore,
): string[] {
  switch (kind) {
    case "human":
      return caps.resolve(identity.gids);
    case "machine":
      return [...MACHINE_CONNECTION_CAPABILITIES];
    case "service":
      return caps.resolve(SERVICE_CAPABILITY_GIDS);
  }
}

async function authenticatePeer(
  args: ConnectArgs,
  ctx: KernelContext,
): Promise<PeerAuthenticationOutcome> {
  const { auth } = ctx;

  if (!args.auth) {
    return { ok: false, error: "Authentication required" };
  }

  const { username } = args.auth;
  if (!username) return { ok: false, error: "Username required" };
  const hasToken = !!args.auth.token;
  const hasPassword = !!args.auth.password;
  if (hasToken && hasPassword) return { ok: false, error: "Provide either password or token" };

  if (hasToken) {
    const result = await auth.authenticatePeerToken(username, args.auth.token!);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.peerId !== null && result.peerId !== args.peer.id.trim()) {
      return { ok: false, error: "Authentication failed" };
    }
    return {
      ok: true,
      identity: withDefaultProcessContext(result.identity),
      principalKind: result.kind,
    };
  }

  if (!hasPassword) return { ok: false, error: "Password or token required" };
  const result = await auth.authenticate(username, args.auth.password!);
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    identity: withDefaultProcessContext(result.identity),
    principalKind: "human",
  };
}

function buildSignalList(kind: PeerPrincipalKind): string[] {
  switch (kind) {
    case "human":
      return [...USER_CONNECTION_SIGNALS, "peer.pong"];
    case "machine":
      return ["target.status", "peer.pong"];
    default:
      return [];
  }
}
