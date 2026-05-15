import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  authorizeProcessSyscall,
  fsAccessPolicyForAuthority,
  remoteSocialProcessAuthority,
} from "./authority";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

describe("process authority", () => {
  it("limits remote social processes to the local gsv target", () => {
    const authority = remoteSocialProcessAuthority({ peerHandle: "Alice.Example" });

    expect(authorizeProcessSyscall(authority, "fs.read", {
      target: "gsv",
      path: "/var/social/alice.example/inbox/msg.md",
    }, IDENTITY)).toBeNull();

    expect(authorizeProcessSyscall(authority, "fs.read", {
      target: "macbook",
      path: "/var/social/alice.example/inbox/msg.md",
    }, IDENTITY)).toBe("Remote social authority can only target gsv");
  });

  it("allows remote social writes only in the peer sandbox", () => {
    const authority = remoteSocialProcessAuthority({ peerHandle: "Alice.Example" });

    expect(authorizeProcessSyscall(authority, "fs.write", {
      path: "/var/social/alice.example/scratch/note.md",
      content: "ok",
    }, IDENTITY)).toBeNull();

    expect(authorizeProcessSyscall(authority, "fs.write", {
      path: "/home/sam/secrets.txt",
      content: "no",
    }, IDENTITY)).toBe("Remote social writes are limited to /var/social/alice.example");

    expect(authorizeProcessSyscall(authority, "fs.delete", {
      path: "/var/social/alice.example/scratch/note.md",
    }, IDENTITY)).toBe("Remote social authority cannot call fs.delete");
  });

  it("enforces the same sandbox for shell filesystem writes", () => {
    const authority = remoteSocialProcessAuthority({ peerHandle: "alice.example" });
    const policy = fsAccessPolicyForAuthority(authority, IDENTITY);

    expect(policy?.canWrite?.("/var/social/alice.example/artifacts/a.txt", "write")).toBeNull();
    expect(policy?.canWrite?.("/var/social/bob.example/a.txt", "write"))
      .toBe("Remote social writes are limited to /var/social/alice.example");
    expect(policy?.canWrite?.("/var/social/alice.example/a.txt", "delete"))
      .toBe("Remote social authority cannot delete files");
  });

  it("limits remote social syscalls to the active peer", () => {
    const authority = remoteSocialProcessAuthority({
      peerHandle: "alice.example",
      threadId: "thread-1",
      messageId: "msg-1",
    });

    expect(authorizeProcessSyscall(authority, "social.message.send", {
      toHandle: "alice.example",
      threadId: "thread-2",
      text: "hello",
    }, IDENTITY)).toBe("Remote social authority is limited to thread thread-1");

    expect(authorizeProcessSyscall(authority, "social.message.send", {
      toHandle: "alice.example",
      threadId: "thread-1",
      text: "hello",
    }, IDENTITY)).toBeNull();

    expect(authorizeProcessSyscall(authority, "social.message.send", {
      toHandle: "bob.example",
      text: "hello",
    }, IDENTITY)).toBe("Remote social authority is limited to alice.example");

    expect(authorizeProcessSyscall(authority, "social.thread.list", {
      peerHandle: "alice.example",
    }, IDENTITY)).toBeNull();

    expect(authorizeProcessSyscall(authority, "social.thread.list", {}, IDENTITY))
      .toBe("Remote social authority requires peerHandle=alice.example");

    expect(authorizeProcessSyscall(authority, "social.message.status.update", {
      messageId: "msg-2",
      state: "completed",
    }, IDENTITY)).toBe("Remote social authority is limited to message msg-1");

    expect(authorizeProcessSyscall(authority, "social.message.status.update", {
      messageId: "msg-1",
      state: "completed",
    }, IDENTITY)).toBeNull();

    expect(authorizeProcessSyscall(authority, "social.contact.add", {
      handle: "alice.example",
    }, IDENTITY)).toBe("Remote social authority cannot call social.contact.add");
  });
});
