import { hashPassword, isLocked, makeShadowEntry } from "../../auth/shadow";
import type { KernelContext } from "../context";
import type { PasswdEntry } from "../../auth/passwd";
import type { ProcessIdentity, SysSetupArgs, SysSetupResult } from "../../syscalls/system";

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

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

async function ensureHomeDir(
  bucket: R2Bucket,
  home: string,
  uid: number,
  gid: number,
): Promise<void> {
  const normalized = home.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return;

  const marker = `${normalized}/.dir`;
  const existing = await bucket.head(marker);
  if (existing) return;

  await bucket.put(marker, new ArrayBuffer(0), {
    customMetadata: {
      uid: String(uid),
      gid: String(gid),
      mode: "750",
      dirmarker: "1",
    },
  });
}

export async function handleSysSetup(
  args: SysSetupArgs,
  ctx: KernelContext,
): Promise<SysSetupResult> {
  const { auth, config } = ctx;

  if (!auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const { username, password } = parseSetupIdentity(args);
  const ai = parseAiConfig(args);
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

  const uid = auth.nextUid();
  const gid = 100;
  const home = `/home/${username}`;

  auth.addUser({
    username,
    uid,
    gid,
    gecos: username,
    home,
    shell: "/bin/init",
  });

  const passwordHash = await hashPassword(password);
  auth.setShadow(makeShadowEntry(username, passwordHash));

  const usersGroup = auth.getGroupByName("users");
  if (usersGroup && !usersGroup.members.includes(username)) {
    auth.updateGroupMembers("users", [...usersGroup.members, username]);
  }

  if (rootPassword) {
    const rootHash = await hashPassword(rootPassword);
    await auth.setPassword("root", rootHash);
  }

  if (ai.provider !== undefined) {
    config.set("config/ai/provider", ai.provider);
  }
  if (ai.model !== undefined) {
    config.set("config/ai/model", ai.model);
  }
  if (ai.apiKey !== undefined) {
    config.set("config/ai/api_key", ai.apiKey);
  }

  let nodeToken: SysSetupResult["nodeToken"];
  if (node) {
    const issued = await auth.issueToken({
      uid,
      kind: "node",
      label: node.label ?? `node:${node.deviceId}`,
      allowedRole: "driver",
      allowedDeviceId: node.deviceId,
      expiresAt: node.expiresAt,
    });
    nodeToken = {
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
  }

  await ensureHomeDir(ctx.env.STORAGE, home, uid, gid);

  const processIdentity: ProcessIdentity = {
    uid,
    gid,
    gids: auth.resolveGids(username, gid),
    username,
    home,
    cwd: home,
    workspaceId: null,
  };

  const rootShadow = auth.getShadowByUsername("root");
  const rootLocked = rootShadow ? isLocked(rootShadow) : true;

  return {
    user: processIdentity,
    rootLocked,
    nodeToken,
  };
}
