/**
 * /etc/group parser and serializer.
 *
 * Format (one entry per line):
 *   groupname:x:gid:member1,member2,...
 *
 * Example:
 *   root:x:0:root
 *   users:x:100:sam,alice
 *   drivers:x:101:
 *   services:x:102:
 */

export type GroupEntry = {
  name: string;
  gid: number;
  members: string[];
};

export function parseGroup(raw: string): GroupEntry[] {
  const entries: GroupEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(":");
    if (parts.length < 4) continue;

    const memberStr = parts[3].trim();
    entries.push({
      name: parts[0],
      // parts[1] is the password placeholder ("x")
      gid: parseInt(parts[2], 10),
      members: memberStr ? memberStr.split(",") : [],
    });
  }
  return entries;
}

export function serializeGroup(entries: GroupEntry[]): string {
  return entries
    .map((e) => `${e.name}:x:${e.gid}:${e.members.join(",")}`)
    .join("\n") + "\n";
}

export function findByName(
  entries: GroupEntry[],
  name: string,
): GroupEntry | undefined {
  return entries.find((e) => e.name === name);
}

export function findByGid(
  entries: GroupEntry[],
  gid: number,
): GroupEntry | undefined {
  return entries.find((e) => e.gid === gid);
}

/** Returns all gids a user belongs to (primary gid from passwd + supplementary from group memberships). */
export function resolveGids(
  groups: GroupEntry[],
  username: string,
  primaryGid: number,
): number[] {
  const gids = new Set<number>([primaryGid]);
  for (const g of groups) {
    if (g.members.includes(username)) {
      gids.add(g.gid);
    }
  }
  return Array.from(gids).sort((a, b) => a - b);
}

export function nextGid(entries: GroupEntry[]): number {
  const max = entries.reduce((m, e) => Math.max(m, e.gid), 0);
  return max < 100 ? 100 : max + 1;
}
