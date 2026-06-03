import { describe, expect, it } from "vitest";
import {
  canOwnerAccessHomeKnowledge,
  canOwnerDelegateRunAs,
  canOwnerRunAsAccount,
  homeUsernameFromPath,
} from "./account-access";

describe("account-access", () => {
  const auth = {
    getPasswdByUid: (uid: number) => {
      if (uid === 1000) return { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" };
      if (uid === 3000) return { uid: 3000, gid: 3000, username: "wiki-builder", home: "/home/wiki-builder" };
      return null;
    },
    getPasswdByUsername: (name: string) => {
      if (name === "alice") return { uid: 1000, gid: 1000, username: "alice" };
      if (name === "wiki-builder") return { uid: 3000, gid: 3000, username: "wiki-builder" };
      return null;
    },
    getPersonalAgentUid: (ownerUid: number) => (ownerUid === 1000 ? 2000 : null),
    getGroupByGid: (gid: number) => {
      if (gid === 3000) return { name: "wiki-builder", gid: 3000, members: [] as string[] };
      return null;
    },
    getGroupByName: (name: string) => {
      if (name === "wiki-builder-run") return { name: "wiki-builder-run", gid: 3001, members: ["alice"] };
      return null;
    },
  };

  it("parses home paths", () => {
    expect(homeUsernameFromPath("/home/wiki-builder/context.d/a.md")).toBe("wiki-builder");
    expect(homeUsernameFromPath("/etc/passwd")).toBeNull();
  });

  it("authorizes package agents via access group for run-as and home overlay", () => {
    const target = { uid: 3000, gid: 3000, username: "wiki-builder" };
    expect(canOwnerDelegateRunAs(auth as never, 1000, target)).toBe(true);
    expect(canOwnerRunAsAccount(auth as never, 1000, target, false)).toBe(true);
    expect(canOwnerAccessHomeKnowledge(auth as never, 1000, "alice", "wiki-builder", false)).toBe(true);
    expect(canOwnerAccessHomeKnowledge(auth as never, 1000, "alice", "bob", false)).toBe(false);
  });

  it("authorizes an owned agent viewer to access the owner's home overlay", () => {
    expect(canOwnerAccessHomeKnowledge(auth as never, 1000, "alice-agent", "alice", false)).toBe(true);
    expect(canOwnerAccessHomeKnowledge(auth as never, 1001, "alice-agent", "alice", false)).toBe(false);
  });
});
