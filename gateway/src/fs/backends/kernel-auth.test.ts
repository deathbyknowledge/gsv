import { describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelRefs } from "../refs";
import { KernelMountBackend } from "./kernel";

const ROOT: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

const USER: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

function makeBackend(identity: ProcessIdentity, authDirectoryWritable: boolean) {
  const auth = {
    serializePasswd: vi.fn(() => "root:x:0:0:root:/root:/bin/init\n"),
    serializeShadow: vi.fn(() => "root:!:0:0:99999:7:::\n"),
    serializeGroup: vi.fn(() => "root:x:0:root\n"),
    importPasswd: vi.fn(),
    importShadow: vi.fn(),
    importGroup: vi.fn(),
  };
  const refs = {
    auth,
    authDirectoryWritable,
  } as unknown as KernelRefs;
  return { auth, backend: new KernelMountBackend(identity, refs, null) };
}

describe("KernelMountBackend auth directory", () => {
  it("makes projected auth files read-only even for the projected root", async () => {
    const { auth, backend } = makeBackend(ROOT, false);

    await expect(backend.readFile("/etc/passwd")).resolves.toContain("root:x:0:0");
    await expect(backend.stat("/etc/passwd")).resolves.toMatchObject({ mode: 0o444 });
    await expect(backend.stat("/etc/shadow")).resolves.toMatchObject({ mode: 0o400 });
    await expect(backend.stat("/etc/group")).resolves.toMatchObject({ mode: 0o444 });

    for (const path of ["/etc/passwd", "/etc/shadow", "/etc/group"]) {
      await expect(backend.writeFile(path, "replacement\n")).rejects.toThrow("EROFS");
      await expect(backend.appendFile(path, "addition\n")).rejects.toThrow("EROFS");
    }

    expect(auth.importPasswd).not.toHaveBeenCalled();
    expect(auth.importShadow).not.toHaveBeenCalled();
    expect(auth.importGroup).not.toHaveBeenCalled();
  });

  it("retains root writes and modes for the authoritative Master directory", async () => {
    const { auth, backend } = makeBackend(ROOT, true);

    await backend.writeFile("/etc/passwd", "passwd\n");
    await backend.writeFile("/etc/shadow", "shadow\n");
    await backend.writeFile("/etc/group", "group\n");

    expect(auth.importPasswd).toHaveBeenCalledWith("passwd\n");
    expect(auth.importShadow).toHaveBeenCalledWith("shadow\n");
    expect(auth.importGroup).toHaveBeenCalledWith("group\n");
    await expect(backend.stat("/etc/passwd")).resolves.toMatchObject({ mode: 0o644 });
    await expect(backend.stat("/etc/shadow")).resolves.toMatchObject({ mode: 0o640 });
  });

  it("retains uid checks in the authoritative Master directory", async () => {
    const { auth, backend } = makeBackend(USER, true);

    await expect(backend.writeFile("/etc/passwd", "replacement\n"))
      .rejects.toThrow("EACCES");
    expect(auth.importPasswd).not.toHaveBeenCalled();
  });
});

describe("KernelMountBackend config writes", () => {
  it("keeps projected /sys config read-only without an authoritative writer", async () => {
    const { backend } = makeBackend(USER, false);

    await expect(backend.writeFile("/sys/users/1000/ai/model", "gpt-test\n"))
      .rejects.toThrow("/sys config is read-only");
  });

  it("routes user and root config writes through the authoritative boundary", async () => {
    const userWrite = vi.fn(async () => {});
    const userBackend = new KernelMountBackend(USER, {
      writeConfig: userWrite,
    } as unknown as KernelRefs, null);
    await userBackend.writeFile("/sys/users/1000/ai/model", "gpt-test\n");
    expect(userWrite).toHaveBeenCalledWith("users/1000/ai/model", "gpt-test");

    const rootWrite = vi.fn(async () => {});
    const rootBackend = new KernelMountBackend(ROOT, {
      writeConfig: rootWrite,
    } as unknown as KernelRefs, null);
    await rootBackend.writeFile("/sys/config/server/name", "my-gsv\n");
    expect(rootWrite).toHaveBeenCalledWith("config/server/name", "my-gsv");
  });

  it("rejects another user's config path before invoking the writer", async () => {
    const writeConfig = vi.fn(async () => {});
    const backend = new KernelMountBackend(USER, {
      writeConfig,
    } as unknown as KernelRefs, null);

    await expect(backend.writeFile("/sys/users/1001/ai/model", "gpt-test\n"))
      .rejects.toThrow("permission denied");
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
