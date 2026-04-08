import { describe, it, expect } from "vitest";
import {
  parsePasswd,
  serializePasswd,
  findByUsername as findPasswdUser,
  findByUid,
  nextUid,
} from "./passwd";
import {
  parseShadow,
  serializeShadow,
  isLocked,
  makeShadowEntry,
  hashPassword,
  hashToken,
  verify,
} from "./shadow";
import {
  parseGroup,
  serializeGroup,
  findByName,
  findByGid,
  resolveGids,
  nextGid,
} from "./group";

// ---------------------------------------------------------------------------
// passwd
// ---------------------------------------------------------------------------
describe("passwd", () => {
  const SAMPLE = [
    "root:x:0:0:root:/root:/bin/sh",
    "sam:x:1000:1000:Sam James:/home/sam:/bin/bash",
    "alice:x:1001:100:Alice:/home/alice:/bin/sh",
  ].join("\n") + "\n";

  it("parses valid entries", () => {
    const entries = parsePasswd(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      username: "root",
      uid: 0,
      gid: 0,
      gecos: "root",
      home: "/root",
      shell: "/bin/sh",
    });
    expect(entries[1]).toEqual({
      username: "sam",
      uid: 1000,
      gid: 1000,
      gecos: "Sam James",
      home: "/home/sam",
      shell: "/bin/bash",
    });
  });

  it("skips comments and blank lines", () => {
    const raw = "# comment\n\nroot:x:0:0:root:/root:/bin/sh\n  \n";
    const entries = parsePasswd(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].username).toBe("root");
  });

  it("skips malformed lines (fewer than 7 fields)", () => {
    const raw = "root:x:0:0:root\nvalid:x:1:1:v:/home/v:/bin/sh\n";
    const entries = parsePasswd(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].username).toBe("valid");
  });

  it("roundtrips through serialize → parse", () => {
    const entries = parsePasswd(SAMPLE);
    const serialized = serializePasswd(entries);
    const reparsed = parsePasswd(serialized);
    expect(reparsed).toEqual(entries);
  });

  it("findByUsername returns the correct entry", () => {
    const entries = parsePasswd(SAMPLE);
    expect(findPasswdUser(entries, "sam")?.uid).toBe(1000);
    expect(findPasswdUser(entries, "nonexistent")).toBeUndefined();
  });

  it("findByUid returns the correct entry", () => {
    const entries = parsePasswd(SAMPLE);
    expect(findByUid(entries, 0)?.username).toBe("root");
    expect(findByUid(entries, 9999)).toBeUndefined();
  });

  it("nextUid returns 1000 when max uid < 1000", () => {
    const entries = parsePasswd("root:x:0:0:root:/root:/bin/sh\n");
    expect(nextUid(entries)).toBe(1000);
  });

  it("nextUid increments past existing uids >= 1000", () => {
    const entries = parsePasswd(SAMPLE);
    expect(nextUid(entries)).toBe(1002);
  });
});

// ---------------------------------------------------------------------------
// shadow
// ---------------------------------------------------------------------------
describe("shadow", () => {
  const SAMPLE = [
    "root:$sha256$abcdef:19800:0:99999:7:::",
    "sam:!:19800:0:99999:7:::",
    "alice:$sha256$123456:19800:0:99999:7:::",
  ].join("\n") + "\n";

  it("parses valid entries", () => {
    const entries = parseShadow(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0].username).toBe("root");
    expect(entries[0].hash).toBe("$sha256$abcdef");
    expect(entries[0].max).toBe("99999");
  });

  it("handles minimal entries (just username:hash)", () => {
    const raw = "testuser:somehash\n";
    const entries = parseShadow(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].username).toBe("testuser");
    expect(entries[0].hash).toBe("somehash");
    expect(entries[0].lastchanged).toBe("");
  });

  it("skips comments and blank lines", () => {
    const raw = "# shadow file\n\nroot:hash::::::: \n";
    const entries = parseShadow(raw);
    expect(entries).toHaveLength(1);
  });

  it("roundtrips through serialize → parse", () => {
    const entries = parseShadow(SAMPLE);
    const serialized = serializeShadow(entries);
    const reparsed = parseShadow(serialized);
    expect(reparsed).toEqual(entries);
  });

  it("isLocked detects locked accounts", () => {
    expect(isLocked({ hash: "!" } as any)).toBe(true);
    expect(isLocked({ hash: "*" } as any)).toBe(true);
    expect(isLocked({ hash: "" } as any)).toBe(true);
    expect(isLocked({ hash: "$token-sha256$abc" } as any)).toBe(false);
    expect(isLocked({ hash: "$pbkdf2-sha512$100000$x$y" } as any)).toBe(false);
  });

  it("makeShadowEntry creates a valid entry", () => {
    const entry = makeShadowEntry("testuser", "$token-sha256$abc");
    expect(entry.username).toBe("testuser");
    expect(entry.hash).toBe("$token-sha256$abc");
    expect(entry.min).toBe("0");
    expect(entry.max).toBe("99999");
    expect(entry.warn).toBe("7");
    expect(parseInt(entry.lastchanged, 10)).toBeGreaterThan(0);
  });

  // -- Token scheme ($token-sha256$) --

  it("hashToken produces a $token-sha256$ prefixed hex string", async () => {
    const hash = await hashToken("mysecret");
    expect(hash.startsWith("$token-sha256$")).toBe(true);
    expect(hash.length).toBe(14 + 64); // "$token-sha256$" + 64 hex chars
  });

  it("hashToken is deterministic", async () => {
    const a = await hashToken("same-input");
    const b = await hashToken("same-input");
    expect(a).toBe(b);
  });

  it("hashToken produces different output for different input", async () => {
    const a = await hashToken("one");
    const b = await hashToken("two");
    expect(a).not.toBe(b);
  });

  it("verify matches a correct token", async () => {
    const hash = await hashToken("correct-token");
    expect(await verify("correct-token", hash)).toBe(true);
  });

  it("verify rejects a wrong token", async () => {
    const hash = await hashToken("correct-token");
    expect(await verify("wrong-token", hash)).toBe(false);
  });

  // -- Password scheme ($pbkdf2-sha512$) --

  it("hashPassword produces a $pbkdf2-sha512$ prefixed string", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash.startsWith("$pbkdf2-sha512$")).toBe(true);
    const parts = hash.split("$");
    expect(parts).toHaveLength(5); // ["", "pbkdf2-sha512", iters, salt, hash]
    expect(parts[2]).toBe("100000");
  });

  it("hashPassword produces different output each call (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("verify matches a correct password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verify("correct-password", hash)).toBe(true);
  });

  it("verify rejects a wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verify("wrong-password", hash)).toBe(false);
  });

  it("hashPassword respects custom iteration count", async () => {
    const hash = await hashPassword("pw", 1000);
    expect(hash).toContain("$1000$");
    expect(await verify("pw", hash)).toBe(true);
  });

  // -- Unified verify edge cases --

  it("verify returns false for locked accounts", async () => {
    expect(await verify("anything", "!")).toBe(false);
    expect(await verify("anything", "*")).toBe(false);
    expect(await verify("anything", "")).toBe(false);
  });

  it("verify returns false for unknown hash scheme", async () => {
    expect(await verify("anything", "$unknown$data")).toBe(false);
  });

  it("verify dispatches correctly across schemes", async () => {
    const tokenHash = await hashToken("my-api-key");
    const pwHash = await hashPassword("my-password");

    expect(await verify("my-api-key", tokenHash)).toBe(true);
    expect(await verify("my-password", pwHash)).toBe(true);

    expect(await verify("my-api-key", pwHash)).toBe(false);
    expect(await verify("my-password", tokenHash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// group
// ---------------------------------------------------------------------------
describe("group", () => {
  const SAMPLE = [
    "root:x:0:root",
    "users:x:100:sam,alice",
    "drivers:x:101:",
    "services:x:102:",
  ].join("\n") + "\n";

  it("parses valid entries", () => {
    const entries = parseGroup(SAMPLE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ name: "root", gid: 0, members: ["root"] });
    expect(entries[1]).toEqual({ name: "users", gid: 100, members: ["sam", "alice"] });
    expect(entries[2]).toEqual({ name: "drivers", gid: 101, members: [] });
  });

  it("skips comments and blank lines", () => {
    const raw = "# groups\n\nroot:x:0:root\n";
    const entries = parseGroup(raw);
    expect(entries).toHaveLength(1);
  });

  it("skips malformed lines", () => {
    const raw = "bad:x:0\ngood:x:1:user\n";
    const entries = parseGroup(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("good");
  });

  it("roundtrips through serialize → parse", () => {
    const entries = parseGroup(SAMPLE);
    const serialized = serializeGroup(entries);
    const reparsed = parseGroup(serialized);
    expect(reparsed).toEqual(entries);
  });

  it("findByName returns the correct entry", () => {
    const entries = parseGroup(SAMPLE);
    expect(findByName(entries, "users")?.gid).toBe(100);
    expect(findByName(entries, "nonexistent")).toBeUndefined();
  });

  it("findByGid returns the correct entry", () => {
    const entries = parseGroup(SAMPLE);
    expect(findByGid(entries, 0)?.name).toBe("root");
    expect(findByGid(entries, 9999)).toBeUndefined();
  });

  it("resolveGids includes primary gid and supplementary groups", () => {
    const entries = parseGroup(SAMPLE);
    const gids = resolveGids(entries, "sam", 1000);
    expect(gids).toEqual([100, 1000]);
  });

  it("resolveGids deduplicates when primary gid matches a group gid", () => {
    const entries = parseGroup(SAMPLE);
    const gids = resolveGids(entries, "root", 0);
    expect(gids).toEqual([0]);
  });

  it("resolveGids returns only primary gid when user has no supplementary groups", () => {
    const entries = parseGroup(SAMPLE);
    const gids = resolveGids(entries, "nobody", 500);
    expect(gids).toEqual([500]);
  });

  it("nextGid returns 100 when max gid < 100", () => {
    const entries = parseGroup("root:x:0:root\n");
    expect(nextGid(entries)).toBe(100);
  });

  it("nextGid increments past existing gids >= 100", () => {
    const entries = parseGroup(SAMPLE);
    expect(nextGid(entries)).toBe(103);
  });
});
