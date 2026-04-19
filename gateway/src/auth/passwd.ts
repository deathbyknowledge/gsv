/**
 * /etc/passwd parser and serializer.
 *
 * Format (one entry per line):
 *   username:x:uid:gid:gecos:home:shell
 *
 * Example:
 *   root:x:0:0:root:/root:/bin/sh
 *   sam:x:1000:1000:Sam:/home/sam:/bin/sh
 */

export type PasswdEntry = {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
};

export function parsePasswd(raw: string): PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(":");
    if (parts.length < 7) continue;

    entries.push({
      username: parts[0],
      // parts[1] is the password placeholder ("x")
      uid: parseInt(parts[2], 10),
      gid: parseInt(parts[3], 10),
      gecos: parts[4],
      home: parts[5],
      shell: parts[6],
    });
  }
  return entries;
}

export function serializePasswd(entries: PasswdEntry[]): string {
  return entries
    .map(
      (e) => `${e.username}:x:${e.uid}:${e.gid}:${e.gecos}:${e.home}:${e.shell}`,
    )
    .join("\n") + "\n";
}

export function findByUsername(
  entries: PasswdEntry[],
  username: string,
): PasswdEntry | undefined {
  return entries.find((e) => e.username === username);
}

export function findByUid(
  entries: PasswdEntry[],
  uid: number,
): PasswdEntry | undefined {
  return entries.find((e) => e.uid === uid);
}

export function nextUid(entries: PasswdEntry[]): number {
  const max = entries.reduce((m, e) => Math.max(m, e.uid), 0);
  return max < 1000 ? 1000 : max + 1;
}
