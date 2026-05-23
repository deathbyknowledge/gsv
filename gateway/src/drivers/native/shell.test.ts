import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleShellExec } from "./shell";
import { handleFsCopy, handleFsTransferRead, handleFsTransferWrite } from "./fs";
import { parseBinaryFrame } from "@gsv/protocol/binary-frame";
import type { KernelContext } from "../../kernel/context";
import type { DeviceRecord } from "../../kernel/devices";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { InstalledPackageRecord } from "../../kernel/packages";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:root/pkg-test:.",
    scope: { kind: "global" },
    manifest: {
      name: "sample-console",
      description: "Sample console",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "root/pkg-test",
        ref: "main",
        subdir: ".",
        resolvedCommit: "abc123",
      },
      entrypoints: [{ name: "Console", kind: "ui" }],
      capabilities: {
        bindings: [],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: { hash: "hash1", mainModule: "index.js", modulePaths: ["index.js"] },
    grants: {
      bindings: [],
      egress: {
        mode: "none",
      },
    },
    enabled: false,
    reviewRequired: true,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  } as InstalledPackageRecord;
}

function makeDevice(partial: Partial<DeviceRecord> & { device_id: string }): DeviceRecord {
  const now = 1_800_000_000_000;
  return {
    device_id: partial.device_id,
    owner_uid: partial.owner_uid ?? IDENTITY.uid,
    label: partial.label ?? partial.device_id,
    description: partial.description ?? "",
    implements: partial.implements ?? ["shell.exec"],
    platform: partial.platform ?? "linux",
    version: partial.version ?? "1.0.0",
    lifecycle: partial.lifecycle ?? "persistent",
    online: partial.online ?? true,
    first_seen_at: partial.first_seen_at ?? now,
    last_seen_at: partial.last_seen_at ?? now,
    connected_at: partial.connected_at ?? now,
    disconnected_at: partial.disconnected_at ?? null,
  };
}

function makeContext(options?: {
  capabilities?: string[];
  config?: Record<string, string>;
  pkg?: InstalledPackageRecord;
  packages?: InstalledPackageRecord[];
  procs?: Partial<KernelContext["procs"]>;
  devices?: KernelContext["devices"];
  auth?: KernelContext["auth"];
  schedules?: KernelContext["schedules"];
  getAppRunner?: KernelContext["getAppRunner"];
  scheduleScheduleWake?: KernelContext["scheduleScheduleWake"];
}): KernelContext {
  const records = [...(options?.packages ?? [options?.pkg ?? makePackage()])];
  const configValues = new Map<string, string>(Object.entries(options?.config ?? {}));
  const findRecord = (packageId: string, scope?: InstalledPackageRecord["scope"]) => {
    const index = records.findIndex((record) =>
      record.packageId === packageId && (!scope || packageScopeKey(record.scope) === packageScopeKey(scope))
    );
    return index >= 0 ? { index, record: records[index] } : null;
  };
  return {
    env: {
      STORAGE: env.STORAGE,
      RIPGIT: {} as Fetcher,
      LOADER: { get() { throw new Error("LOADER should not be used in pkg shell tests"); } },
    } as unknown as Env,
    auth: options?.auth ?? null as never,
    caps: null as never,
    config: {
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.2.0";
        return configValues.get(key) ?? null;
      },
      list(prefix: string) {
        const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
        return [...configValues.entries()]
          .filter(([key]) => key.startsWith(normalized))
          .map(([key, value]) => ({ key, value }))
          .sort((left, right) => left.key.localeCompare(right.key));
      },
    } as never,
    devices: options?.devices ?? null as never,
    procs: {
      getMounts() {
        return [];
      },
      get() {
        return {
          profile: "task",
          uid: IDENTITY.uid,
          workspaceId: IDENTITY.workspaceId,
        };
      },
      ...(options?.procs ?? {}),
    } as never,
    workspaces: null as never,
    packages: {
      list(opts?: { scopes?: readonly InstalledPackageRecord["scope"][] }) {
        if (!opts?.scopes) {
          return [...records];
        }
        const scopeKeys = new Set(opts.scopes.map(packageScopeKey));
        return records.filter((record) => scopeKeys.has(packageScopeKey(record.scope)));
      },
      resolve(packageId: string, scopes?: readonly InstalledPackageRecord["scope"][]) {
        for (const scope of scopes ?? []) {
          const found = findRecord(packageId, scope);
          if (found) return found.record;
        }
        return records.find((record) => record.packageId === packageId) ?? null;
      },
      get(packageId: string, scope?: InstalledPackageRecord["scope"]) {
        return findRecord(packageId, scope)?.record ?? null;
      },
      setEnabled(packageId: string, enabled: boolean, scope?: InstalledPackageRecord["scope"]) {
        const found = findRecord(packageId, scope);
        if (!found) return null;
        const existing = found.record;
        const updated = { ...existing, enabled, updatedAt: existing.updatedAt + 1 };
        records[found.index] = updated;
        return updated;
      },
      setReviewed(packageId: string, reviewedAt: number, scope?: InstalledPackageRecord["scope"]) {
        const found = findRecord(packageId, scope);
        if (!found) return null;
        const existing = found.record;
        const updated = { ...existing, reviewedAt, reviewRequired: true, updatedAt: existing.updatedAt + 1 };
        records[found.index] = updated;
        return updated;
      },
    } as never,
    adapters: null as never,
    runRoutes: null as never,
    schedules: options?.schedules,
    connection: null as never,
    identity: {
      role: "user",
      process: IDENTITY,
      capabilities: options?.capabilities ?? ["pkg.list", "repo.refs", "repo.log"],
    },
    processId: "task:pkg",
    serverVersion: "0.2.0",
    getAppRunner: options?.getAppRunner,
    scheduleScheduleWake: options?.scheduleScheduleWake,
  } as KernelContext;
}

function packageScopeKey(scope: InstalledPackageRecord["scope"]): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "user":
      return `user:${scope.uid}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
  }
}

describe("native shell execution", () => {
  it("keeps command stderr visible on non-zero exits", async () => {
    const result = await handleShellExec(
      { input: "printf 'real failure\\n' >&2; exit 7" },
      makeContext(),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("real failure");
    expect(result.error).toContain("real failure");
  });
});

describe("targets native command", () => {
  it("lists targets with pagination and keeps devices as an alias", async () => {
    const records = [
      makeDevice({
        device_id: "macbook",
        label: "Work MacBook",
        description: "Laptop",
        platform: "darwin",
        implements: ["shell.exec", "fs.read"],
      }),
      makeDevice({
        device_id: "browser:abc",
        label: "Browser",
        platform: "browser",
        lifecycle: "ephemeral",
        implements: ["shell.exec", "fs.*"],
      }),
    ];
    const devices = {
      listForUser: vi.fn(() => records),
    } as unknown as KernelContext["devices"];

    const result = await handleShellExec(
      { input: "targets list --limit 2" },
      makeContext({ capabilities: ["sys.device.list"], devices }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("TARGET\tKIND\tSTATE\tLIFE\tPLATFORM\tCAPS\tLABEL");
    expect(result.stdout).toContain("gsv\tgsv\tonline\tpersistent\tcloudflare-worker");
    expect(result.stdout).toContain("browser:abc\tbrowser\tonline\tephemeral\tbrowser");
    expect(result.stdout).toContain("Showing 1-2 of 3");

    const alias = await handleShellExec(
      { input: "devices search macbook" },
      makeContext({ capabilities: ["sys.device.list"], devices }),
    );
    expect(alias.ok).toBe(true);
    expect(alias.stdout).toContain("macbook\tnative-device\tonline\tpersistent\tdarwin");
  });

  it("shows target details", async () => {
    const record = makeDevice({
      device_id: "macbook",
      label: "Work MacBook",
      description: "Laptop",
      platform: "darwin",
      implements: ["shell.exec", "fs.read"],
    });
    const devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => record),
    } as unknown as KernelContext["devices"];
    const auth = {
      getPasswdByUid: vi.fn(() => ({ username: "sam" })),
    } as unknown as KernelContext["auth"];

    const result = await handleShellExec(
      { input: "targets show macbook" },
      makeContext({ capabilities: ["sys.device.get"], devices, auth }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("target: macbook");
    expect(result.stdout).toContain("kind: native-device");
    expect(result.stdout).toContain("owner: sam (uid 1000)");
    expect(result.stdout).toContain("- shell.exec");
    expect(result.stdout).toContain("- fs.read");
  });
});

describe("proc native command", () => {
  it("lists spawnable profiles", async () => {
    const result = await handleShellExec(
      { input: "proc profiles" },
      makeContext({ capabilities: ["proc.profile.list"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("init\tsystem\tyes\tno\tPersonal Agent");
    expect(result.stdout).toContain("task\tsystem\tyes\tno\tWorker");
    expect(result.stdout).toContain("cron\tsystem\tno\tyes\tCron");
  });

  it("routes spawn through the native proc command surface", async () => {
    const result = await handleShellExec(
      { input: "proc spawn --workspace nowhere --prompt hello" },
      makeContext({ capabilities: ["proc.spawn"] }),
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--workspace must be inherit");
  });
});

describe("fs copy", () => {
  it("reads only requested transfer ranges", async () => {
    const sourceKey = "home/sam/copy-test/ranged-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "0123456789", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const sent: unknown[] = [];
    const ctx = makeContext();
    ctx.connection = {
      send(message: unknown) {
        sent.push(message);
      },
    } as never;

    const result = await handleFsTransferRead({
      path: "/home/sam/copy-test/ranged-source.txt",
      offset: 2,
      length: 4,
      streamId: 123,
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/ranged-source.txt",
      offset: 2,
      bytesRead: 4,
      eof: false,
    });
    expect(sent).toHaveLength(1);
    const frame = parseBinaryFrame(sent[0] as ArrayBuffer);
    expect(frame).toMatchObject({ streamId: 123 });
    expect(new TextDecoder().decode(frame?.payload)).toBe("2345");
  });

  it("writes native transfer chunks", async () => {
    const destinationKey = "home/sam/copy-test/native-transfer-write.txt";
    await env.STORAGE.delete(destinationKey);

    const first = await handleFsTransferWrite({
      path: "/home/sam/copy-test/native-transfer-write.txt",
      offset: 0,
      expectedSize: 11,
      streamId: 123,
    }, makeContext(), new TextEncoder().encode("hello "));
    const second = await handleFsTransferWrite({
      path: "/home/sam/copy-test/native-transfer-write.txt",
      offset: 6,
      expectedSize: 11,
      streamId: 123,
      done: true,
    }, makeContext(), new TextEncoder().encode("world"));

    expect(first).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/native-transfer-write.txt",
      offset: 0,
      bytesWritten: 6,
      done: false,
    });
    expect(second).toMatchObject({
      ok: true,
      path: "/home/sam/copy-test/native-transfer-write.txt",
      offset: 6,
      bytesWritten: 5,
      done: true,
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("hello world");
  });

  it("copies gsv files through the fs.copy syscall", async () => {
    const sourceKey = "home/sam/copy-test/source.txt";
    const destinationKey = "home/sam/copy-test/destination.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.delete(destinationKey);
    await env.STORAGE.put(sourceKey, "copied data", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/destination.txt" },
    }, makeContext());

    expect(result).toMatchObject({
      ok: true,
      size: "copied data".length,
      contentType: "text/plain",
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("copied data");
  });

  it("copies gsv files through the native cp shell command", async () => {
    const sourceKey = "home/sam/copy-test/shell-source.txt";
    const destinationKey = "home/sam/copy-test/shell-destination.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.delete(destinationKey);
    await env.STORAGE.put(sourceKey, "shell copied", {
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });

    const result = await handleShellExec(
      { input: "cp /home/sam/copy-test/shell-source.txt /home/sam/copy-test/shell-destination.txt" },
      makeContext({ capabilities: ["shell.exec"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("shell copied");
  });

  it("routes native cp to browser targets with colon ids", async () => {
    const sourceKey = "home/sam/copy-test/browser-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "to browser", {
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const browserTarget = "browser:conn-123";
    const ctx = makeContext({ capabilities: ["fs.read", "fs.write"] }) as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
      listForUser: vi.fn(() => [{ device_id: browserTarget }]),
    } as never;
    const writes: Array<{ offset: number; bytes: Uint8Array; done?: boolean }> = [];

    const result = await handleShellExec(
      { input: `cp /home/sam/copy-test/browser-source.txt ${browserTarget}:/home/browser/browser-destination.txt` },
      ctx,
      {
        fsCopyTransport: {
          async requestDevice(deviceId, call, args) {
            expect(deviceId).toBe(browserTarget);
            if (call === "fs.transfer.stat") {
              return { ok: false, error: "not found" };
            }
            expect(call).toBe("fs.transfer.write");
            return { ok: true, path: "/home/browser/browser-destination.txt", offset: 0, bytesWritten: 0, done: Boolean((args as { done?: boolean }).done) };
          },
          async requestDeviceBinary(deviceId, call, args, options) {
            expect(deviceId).toBe(browserTarget);
            expect(call).toBe("fs.transfer.write");
            writes.push({
              offset: (args as { offset: number }).offset,
              bytes: options?.payload ?? new Uint8Array(),
              done: (args as { done?: boolean }).done,
            });
            return {
              data: { ok: true, path: "/home/browser/browser-destination.txt", offset: 0, bytesWritten: options?.payload?.byteLength ?? 0, done: Boolean((args as { done?: boolean }).done) },
              streamId: 1,
            };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(writes.length).toBeGreaterThan(0);
    const payload = writes
      .filter((write) => !write.done)
      .map((write) => new TextDecoder().decode(write.bytes))
      .join("");
    expect(payload).toBe("to browser");
  });

  it("streams gsv files to a device target", async () => {
    const sourceKey = "home/sam/copy-test/device-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "to device", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;
    const writes: Array<{ offset: number; bytes: Uint8Array; done?: boolean }> = [];

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/device-source.txt" },
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return { ok: false, error: "not found" };
        }
        expect(call).toBe("fs.transfer.write");
        return { ok: true, path: "/tmp/device-destination.txt", offset: 0, bytesWritten: 0, done: Boolean((args as { done?: boolean }).done) };
      },
      async requestDeviceBinary(deviceId, call, args, options) {
        expect(deviceId).toBe("rearden");
        expect(call).toBe("fs.transfer.write");
        writes.push({
          offset: (args as { offset: number }).offset,
          bytes: options?.payload ?? new Uint8Array(),
          done: (args as { done?: boolean }).done,
        });
        return {
          data: { ok: true, path: "/tmp/device-destination.txt", offset: 0, bytesWritten: options?.payload?.byteLength ?? 0, done: Boolean((args as { done?: boolean }).done) },
          streamId: 1,
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      size: "to device".length,
      destination: { target: "rearden", path: "/tmp/device-destination.txt" },
    });
    const payload = writes
      .filter((write) => !write.done)
      .map((write) => new TextDecoder().decode(write.bytes))
      .join("");
    expect(payload).toBe("to device");
    expect(writes.at(-1)?.done).toBe(true);
  });

  it("allows transfer-only device targets without fs.copy", async () => {
    const sourceKey = "home/sam/copy-test/transfer-only-source.txt";
    await env.STORAGE.delete(sourceKey);
    await env.STORAGE.put(sourceKey, "transfer only", {
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
    });
    const canHandle = vi.fn((_deviceId: string, syscall: string) =>
      syscall === "fs.transfer.stat" || syscall === "fs.transfer.write"
    );
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle,
    } as never;
    const writes: Uint8Array[] = [];

    const result = await handleFsCopy({
      source: { target: "gsv", path: "/home/sam/copy-test/transfer-only-source.txt" },
      destination: { target: "browser:target", path: "/tmp/transfer-only.txt" },
    }, ctx, {
      async requestDevice(deviceId, call) {
        expect(deviceId).toBe("browser:target");
        expect(call).toBe("fs.transfer.stat");
        return { ok: false, error: "not found" };
      },
      async requestDeviceBinary(deviceId, call, args, options) {
        expect(deviceId).toBe("browser:target");
        expect(call).toBe("fs.transfer.write");
        if (!(args as { done?: boolean }).done) {
          writes.push(options?.payload ?? new Uint8Array());
        }
        return {
          data: { ok: true, path: "/tmp/transfer-only.txt", offset: (args as { offset: number }).offset, bytesWritten: options?.payload?.byteLength ?? 0, done: Boolean((args as { done?: boolean }).done) },
          streamId: 1,
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      destination: { target: "browser:target", path: "/tmp/transfer-only.txt" },
    });
    expect(canHandle).not.toHaveBeenCalledWith("browser:target", "fs.copy");
    expect(writes.map((chunk) => new TextDecoder().decode(chunk)).join("")).toBe("transfer only");
  });

  it("streams device files to gsv", async () => {
    const destinationKey = "home/sam/copy-test/from-device.txt";
    await env.STORAGE.delete(destinationKey);
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;

    const result = await handleFsCopy({
      source: { target: "rearden", path: "/tmp/source.txt" },
      destination: { target: "gsv", path: "/home/sam/copy-test/from-device.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        if (call === "fs.transfer.stat") {
          return { ok: true, path: "/tmp/source.txt", size: 11, isFile: true, isDirectory: false, contentType: "text/plain" };
        }
        expect(call).toBe("fs.transfer.read");
        return {
          ok: true,
          path: "/tmp/source.txt",
          offset: (args as { offset: number }).offset,
          bytesRead: 0,
          eof: true,
        };
      },
      async requestDeviceBinary(deviceId, call, args) {
        expect(deviceId).toBe("rearden");
        expect(call).toBe("fs.transfer.read");
        const offset = (args as { offset: number }).offset;
        const text = "hello world".slice(offset);
        return {
          data: {
            ok: true,
            path: "/tmp/source.txt",
            offset,
            bytesRead: text.length,
            eof: true,
          },
          payload: new TextEncoder().encode(text),
          flags: 3,
          streamId: 1,
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      size: 11,
      source: { target: "rearden", path: "/tmp/source.txt" },
    });
    expect(await (await env.STORAGE.get(destinationKey))?.text()).toBe("hello world");
  });

  it("round trips target transfers through gsv tmp", async () => {
    const tmpKey = "tmp/browser-transfer.txt";
    await env.STORAGE.delete(tmpKey);
    const ctx = makeContext() as KernelContext;
    ctx.devices = {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
    } as never;

    const inbound = await handleFsCopy({
      source: { target: "browser:source", path: "/tmp/browser-transfer.txt" },
      destination: { target: "gsv", path: "/tmp/browser-transfer.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("browser:source");
        if (call === "fs.transfer.stat") {
          return { ok: true, path: "/tmp/browser-transfer.txt", size: 20, isFile: true, isDirectory: false, contentType: "text/plain" };
        }
        expect(call).toBe("fs.transfer.read");
        return {
          ok: true,
          path: "/tmp/browser-transfer.txt",
          offset: (args as { offset: number }).offset,
          bytesRead: 20,
          eof: true,
        };
      },
      async requestDeviceBinary(deviceId, call) {
        expect(deviceId).toBe("browser:source");
        expect(call).toBe("fs.transfer.read");
        return {
          data: { ok: true, path: "/tmp/browser-transfer.txt", offset: 0, bytesRead: 20, eof: true },
          payload: new TextEncoder().encode("binary transfer test"),
          flags: 3,
          streamId: 1,
        };
      },
    });

    expect(inbound).toMatchObject({ ok: true, size: 20 });
    expect(await (await env.STORAGE.get(tmpKey))?.text()).toBe("binary transfer test");

    const writes: Uint8Array[] = [];
    const outbound = await handleFsCopy({
      source: { target: "gsv", path: "/tmp/browser-transfer.txt" },
      destination: { target: "browser:dest", path: "/home/browser/readback.txt" },
    }, ctx, {
      async requestDevice(deviceId, call, args) {
        expect(deviceId).toBe("browser:dest");
        if (call === "fs.transfer.stat") {
          return { ok: false, error: "not found" };
        }
        expect(call).toBe("fs.transfer.write");
        return { ok: true, path: "/home/browser/readback.txt", offset: 0, bytesWritten: 0, done: Boolean((args as { done?: boolean }).done) };
      },
      async requestDeviceBinary(deviceId, call, args, options) {
        expect(deviceId).toBe("browser:dest");
        expect(call).toBe("fs.transfer.write");
        if (!(args as { done?: boolean }).done) {
          writes.push(options?.payload ?? new Uint8Array());
        }
        return {
          data: { ok: true, path: "/home/browser/readback.txt", offset: (args as { offset: number }).offset, bytesWritten: options?.payload?.byteLength ?? 0, done: Boolean((args as { done?: boolean }).done) },
          streamId: 1,
        };
      },
    });

    expect(outbound).toMatchObject({ ok: true, size: 20 });
    expect(writes.map((chunk) => new TextDecoder().decode(chunk)).join("")).toBe("binary transfer test");
  });
});

describe("pkg shell command", () => {
  it("shows codemode command usage", async () => {
    const result = await handleShellExec(
      { input: "codemode --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("codemode <script.js>");
    expect(result.stderr).toBe("");
  });

  it("shows mcp command usage", async () => {
    const result = await handleShellExec(
      { input: "mcp --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("mcp list");
    expect(result.stdout).toContain("mcp tools [server-id|name]");
    expect(result.stdout).toContain("mcp call <server-id|name> <tool-name|codemode-function>");
    expect(result.stderr).toBe("");
  });

  it("lists MCP servers through the native shell command", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] }) as KernelContext;
    Object.assign(ctx, {
      mcpServers: {
        list: () => [{
          serverId: "server-1",
          uid: IDENTITY.uid,
          name: "Search",
          url: "https://mcp.example.com/mcp",
          transport: "auto",
          createdAt: 1,
          updatedAt: 2,
        }],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [],
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: {} }],
        listResources: () => [],
        listPrompts: () => [],
      },
    });

    const result = await handleShellExec(
      { input: "mcp list" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("SERVER_ID\tSTATE\tTOOLS\tRES\tPROMPTS\tAUTH\tNAME\tURL");
    expect(result.stdout).toContain("server-1\tready\t1\t0\t0\t-\tSearch\thttps://mcp.example.com/mcp");
    expect(result.stderr).toBe("");
  });

  it("lists MCP tools with CodeMode function names", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.list"] }) as KernelContext;
    Object.assign(ctx, {
      mcpServers: {
        list: () => [{
          serverId: "server-1",
          uid: IDENTITY.uid,
          name: "Search",
          url: "https://mcp.example.com/mcp",
          transport: "auto",
          createdAt: 1,
          updatedAt: 2,
        }],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [],
        listTools: () => [{ name: "lookup-record", description: "Lookup records", inputSchema: { required: ["query"] } }],
        listResources: () => [],
        listPrompts: () => [],
      },
    });

    const result = await handleShellExec(
      { input: "mcp tools Search" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("SERVER_ID\tSERVER\tSTATE\tTOOL\tCODEMODE\tREQUIRED\tDESCRIPTION");
    expect(result.stdout).toContain("server-1\tSearch\tready\tlookup-record");
    expect(result.stdout).toContain("lookup_record");
    expect(result.stdout).toContain("Search_lookup_record");
    expect(result.stdout).toContain("query");
    expect(result.stderr).toBe("");
  });

  it("calls MCP tools through the native shell command", async () => {
    const ctx = makeContext({ capabilities: ["sys.mcp.call"] }) as KernelContext;
    const callMcpTool = vi.fn(async () => ({
      content: [{ type: "text", text: "found" }],
    }));
    const server = {
      serverId: "server-1",
      uid: IDENTITY.uid,
      name: "Search",
      url: "https://mcp.example.com/mcp",
      transport: "auto",
      createdAt: 1,
      updatedAt: 2,
    };
    Object.assign(ctx, {
      mcpServers: {
        get: () => server,
        list: () => [server],
      },
      mcp: {
        mcpConnections: {
          "server-1": { connectionState: "ready" },
        },
        listServers: () => [],
        listTools: () => [{ name: "lookup", description: "Lookup", inputSchema: {} }],
        listResources: () => [],
        listPrompts: () => [],
      },
      callMcpTool,
    });

    const result = await handleShellExec(
      { input: "mcp call Search lookup --arg query=gsv" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledWith("server-1", "lookup", { query: "gsv" });
    expect(result.stdout).toBe("found\n");
    expect(result.stderr).toBe("");
  });

  it("shows proc command usage", async () => {
    const result = await handleShellExec(
      { input: "proc --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("proc self");
    expect(result.stdout).toContain("proc send <pid>");
    expect(result.stdout).toContain("proc call <pid>");
    expect(result.stderr).toBe("");
  });

  it("exposes the current GSV process id to shell commands", async () => {
    const result = await handleShellExec(
      { input: "printf \"$GSV_PID\\n\" && proc self" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("task:pkg\ntask:pkg\n");
    expect(result.stderr).toBe("");
  });

  it("shows sched command usage", async () => {
    const result = await handleShellExec(
      { input: "sched --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sched add --name NAME");
    expect(result.stdout).toContain("sched run <id>");
    expect(result.stderr).toBe("");
  });

  it("lists and shows profile skills through the skills command", async () => {
    const skill = [
      "---",
      "name: demo-workflow",
      "description: Demonstrates the skills command.",
      "---",
      "",
      "# Demo Workflow",
      "",
      "Use this for tests.",
    ].join("\n");

    const result = await handleShellExec(
      { input: "skills list && skills show demo-workflow" },
      makeContext({
        config: {
          "config/ai/profile/task/skills.d/demo-workflow/SKILL.md": skill,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("demo-workflow\tprofile:task");
    expect(result.stdout).toContain("path: /sys/config/ai/profile/task/skills.d/demo-workflow/SKILL.md");
    expect(result.stdout).toContain("# Demo Workflow");
    expect(result.stderr).toBe("");
  });

  it("creates a process-spawn schedule from the sched command", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-1",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.afterMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));

    const result = await handleShellExec(
      { input: "sched add --name \"quick check\" --after 30s --profile cron \"Run the quick check.\"" },
      makeContext({
        capabilities: ["sched.add"],
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: IDENTITY.uid,
      name: "quick check",
      expression: { kind: "after", afterMs: 30_000 },
      target: {
        kind: "process.spawn",
        profile: "cron",
        prompt: "Run the quick check.",
      },
    }));
    expect(wake).toHaveBeenCalledWith("sched-1", expect.any(Number));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-1", "wake-1");
  });

  it("creates a process-event schedule from the sched command", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-2",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.everyMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));

    const result = await handleShellExec(
      { input: "sched add --name \"ops pulse\" --every 15m --pid init:1000 --conversation ops --message \"Run pulse.\"" },
      makeContext({
        capabilities: ["sched.add"],
        procs: {
          get: vi.fn(() => ({
            uid: IDENTITY.uid,
            workspaceId: null,
          })),
        } as Partial<KernelContext["procs"]>,
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-2");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "ops pulse",
      expression: { kind: "every", everyMs: 900_000 },
      target: {
        kind: "process.event",
        pid: "init:1000",
        conversationId: "ops",
        message: "Run pulse.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-2", "wake-1");
  });

  it("shows schedule last status and error in sched list", async () => {
    const result = await handleShellExec(
      { input: "sched list --all" },
      makeContext({
        capabilities: ["sched.list"],
        schedules: {
          list: vi.fn(() => ({
            count: 1,
            records: [{
              id: "sched-err",
              ownerUid: IDENTITY.uid,
              creator: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
              runAs: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
              name: "broken target",
              enabled: false,
              expression: { kind: "after", afterMs: 30_000 },
              target: { kind: "process.event", pid: "missing", message: "Run." },
              overlapPolicy: "skip",
              createdAtMs: 1,
              updatedAtMs: 2,
              state: {
                nextRunAtMs: null,
                runningAtMs: null,
                lastRunAtMs: 3,
                lastStatus: "error",
                lastError: "Process not found: missing",
                lastDurationMs: 4,
                runCount: 1,
              },
            }],
          })),
        } as unknown as KernelContext["schedules"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("LAST\tERROR");
    expect(result.stdout).toContain("error\tProcess not found: missing");
  });

  it("defaults to the current package source for manifest inspection", async () => {
    const result = await handleShellExec(
      { input: "pkg manifest", cwd: "/src/packages/sample-console" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"name": "sample-console"');
    expect(result.stderr).toBe("");
  });

  it("preserves scoped package identity when defaulting from the source cwd", async () => {
    const packageId = "import:root/pkg-test:.";
    const globalPackage = makePackage({
      packageId,
      scope: { kind: "global" },
      manifest: {
        ...makePackage().manifest,
        source: {
          repo: "root/pkg-test",
          ref: "stable",
          subdir: ".",
          resolvedCommit: "global123",
        },
      },
    });
    const userPackage = makePackage({
      packageId,
      scope: { kind: "user", uid: 1000 },
      manifest: {
        ...makePackage().manifest,
        source: {
          repo: "root/pkg-test",
          ref: "dev",
          subdir: ".",
          resolvedCommit: "user123",
        },
      },
    });

    const result = await handleShellExec(
      { input: "pkg manifest", cwd: "/src/packages/sample-console--root-pkg-test" },
      makeContext({ packages: [userPackage, globalPackage] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"ref": "stable"');
    expect(result.stdout).not.toContain('"ref": "dev"');
    expect(result.stderr).toBe("");
  });

  it("defaults to the current package from custom source mounts", async () => {
    const result = await handleShellExec(
      { input: "pkg manifest", cwd: "/src/package/src" },
      makeContext({
        procs: {
          getMounts: vi.fn(() => [{
            kind: "ripgit-source",
            mountPath: "/src/package",
            packageId: "import:root/pkg-test:.",
            repo: "root/pkg-test",
            ref: "main",
            resolvedCommit: "abc123",
            subdir: ".",
          }]),
        } as Partial<KernelContext["procs"]>,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"name": "sample-console"');
    expect(result.stderr).toBe("");
  });

  it("shows review status in pkg list output", async () => {
    const result = await handleShellExec(
      { input: "pkg list" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sample-console");
    expect(result.stdout).toContain("pending");
  });

  it("enables an approved package through pkg enable", async () => {
    const result = await handleShellExec(
      { input: "pkg enable", cwd: "/src/packages/sample-console" },
      makeContext({
        capabilities: ["pkg.install"],
        pkg: makePackage({
          scope: { kind: "user", uid: 1000 },
          reviewedAt: 100,
          reviewRequired: true,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("enabled sample-console");
    expect(result.stderr).toBe("");
  });

  it("runs package commands through app runner", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "hello from runner\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "hello-world alpha beta" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            entrypoints: [
              {
                name: "Hello World",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "hello-world",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello from runner");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.kind).toBe("ensure");
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "hello-world",
        args: ["alpha", "beta"],
        cwd: "/home/sam",
        uid: 1000,
        gid: 1000,
        username: "sam",
      },
    });
  });

  it("allows the builtin Wiki package to provide the wiki command", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "wiki package command\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "wiki search auth" },
      makeContext({
        pkg: makePackage({
          packageId: "builtin:wiki@0.1.0",
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            name: "wiki",
            source: {
              repo: "root/gsv",
              ref: "main",
              subdir: "builtin-packages/wiki",
              resolvedCommit: "abc123",
            },
            entrypoints: [
              {
                name: "wiki",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "wiki",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("wiki package command");
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "wiki",
        args: ["search", "auth"],
        cwd: "/home/sam",
        uid: 1000,
        gid: 1000,
        username: "sam",
      },
    });
  });

  it("does not allow non-builtin packages to shadow the wiki command", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "shadowed wiki command\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "wiki search auth" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            name: "wiki",
            entrypoints: [
              {
                name: "wiki",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "wiki",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("shadowed wiki command");
    expect(calls).toHaveLength(0);
  });
});
