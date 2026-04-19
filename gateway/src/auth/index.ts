export type { PasswdEntry } from "./passwd";
export type { ShadowEntry } from "./shadow";
export type { GroupEntry } from "./group";

export {
  parsePasswd,
  serializePasswd,
  findByUsername as findPasswdByUsername,
  findByUid,
  nextUid,
} from "./passwd";

export {
  parseShadow,
  serializeShadow,
  findByUsername as findShadowByUsername,
  isLocked,
  makeShadowEntry,
  hashPassword,
  hashToken,
  verify,
} from "./shadow";

export {
  parseGroup,
  serializeGroup,
  findByName as findGroupByName,
  findByGid,
  resolveGids,
  nextGid,
} from "./group";

import { parsePasswd, serializePasswd, findByUsername as findPasswdUser } from "./passwd";
import { parseShadow, serializeShadow, makeShadowEntry, verify, hashToken } from "./shadow";
import { parseGroup, serializeGroup, resolveGids } from "./group";

const ETC_PASSWD = "/etc/passwd";
const ETC_SHADOW = "/etc/shadow";
const ETC_GROUP = "/etc/group";

const ETC_READABLE = { owner: "0", gid: "0", mode: "644" };
const ETC_SHADOW_META = { owner: "0", gid: "0", mode: "640" };

export type AuthIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
};

export type AuthResult =
  | { ok: true; identity: AuthIdentity }
  | { ok: false; error: string };

/**
 * Authenticate a user by username + token against /etc/passwd and /etc/shadow.
 * Returns resolved uid, gid, supplementary gids, and home directory.
 */
export async function authenticate(
  bucket: R2Bucket,
  username: string,
  token: string,
): Promise<AuthResult> {
  const [passwdRaw, shadowRaw, groupRaw] = await Promise.all([
    readEtcFile(bucket, ETC_PASSWD),
    readEtcFile(bucket, ETC_SHADOW),
    readEtcFile(bucket, ETC_GROUP),
  ]);

  if (!passwdRaw || !shadowRaw || !groupRaw) {
    return { ok: false, error: "System not bootstrapped" };
  }

  const passwdEntries = parsePasswd(passwdRaw);
  const shadowEntries = parseShadow(shadowRaw);
  const groupEntries = parseGroup(groupRaw);

  const user = findPasswdUser(passwdEntries, username);
  if (!user) {
    return { ok: false, error: "Unknown user" };
  }

  const shadow = shadowEntries.find((e) => e.username === username);
  if (!shadow) {
    return { ok: false, error: "No credentials found" };
  }

  const valid = await verify(token, shadow.hash);
  if (!valid) {
    return { ok: false, error: "Authentication failed" };
  }

  const gids = resolveGids(groupEntries, username, user.gid);

  return {
    ok: true,
    identity: {
      uid: user.uid,
      gid: user.gid,
      gids,
      username: user.username,
      home: user.home,
    },
  };
}

/**
 * First-boot provisioning. If /etc/passwd doesn't exist, create the
 * default system files (like a live USB first boot with uid/gid 0 = root).
 *
 * If a rootToken is provided, it's hashed and stored in /etc/shadow.
 * Otherwise root has a locked account (token-less, accepts any connection as root
 * until a token is set).
 */
export async function ensureBootstrapped(
  bucket: R2Bucket,
  rootToken?: string,
): Promise<{ bootstrapped: boolean }> {
  const existing = await bucket.head(ETC_PASSWD);
  if (existing) {
    return { bootstrapped: false };
  }

  const passwd = serializePasswd([
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
  ]);

  const hash = rootToken ? await hashToken(rootToken) : "!";
  const shadow = serializeShadow([makeShadowEntry("root", hash)]);

  const group = serializeGroup([
    { name: "root", gid: 0, members: ["root"] },
    { name: "users", gid: 100, members: [] },
    { name: "drivers", gid: 101, members: [] },
    { name: "services", gid: 102, members: [] },
  ]);

  await Promise.all([
    bucket.put(ETC_PASSWD, passwd, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: ETC_READABLE,
    }),
    bucket.put(ETC_SHADOW, shadow, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: ETC_SHADOW_META,
    }),
    bucket.put(ETC_GROUP, group, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: ETC_READABLE,
    }),
  ]);

  return { bootstrapped: true };
}

async function readEtcFile(
  bucket: R2Bucket,
  path: string,
): Promise<string | null> {
  const object = await bucket.get(path);
  if (!object) return null;
  return object.text();
}
