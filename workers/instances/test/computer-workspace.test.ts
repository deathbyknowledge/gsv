import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ComputerConnection } from "../src/computer-connection";
import { restoreWorkspace, saveWorkspace } from "../src/computer-workspace";
import { openedWorkspaceBytes, openWorkspace, sealedWorkspaceBytes, sealWorkspace, WORKSPACE_CHUNK_BYTES, workspaceKey } from "../src/workspace-codec";
import { FakeMachine } from "./fake-machine";

const key = () => crypto.getRandomValues(new Uint8Array(32)).buffer;
const bytes = (size: number) => {
  const value = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(value.subarray(i, Math.min(size, i + 65536)));
  return value;
};
// Deep equality on megabytes is slower than the work under test.
const digest = async (value: Uint8Array | undefined) => value && new Uint8Array(await crypto.subtle.digest("SHA-256", value));
async function pipe(input: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>, pieces = 3): Promise<Uint8Array> {
  const step = Math.max(1, Math.ceil(input.byteLength / pieces));
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < input.byteLength; offset += step) controller.enqueue(input.slice(offset, offset + step));
    controller.close();
  } });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

function machine() {
  const pair = new WebSocketPair();
  const fake = new FakeMachine();
  pair[1].accept();
  fake.attach(pair[1]);
  const connection = new ComputerConnection(pair[0], () => {});
  return { fake, connection, close: () => connection.close() };
}

describe("saved workspace format", () => {
  it("round-trips any size in chunks and states its sealed size exactly", async () => {
    const raw = await workspaceKey(key());
    for (const size of [0, 1, WORKSPACE_CHUNK_BYTES - 1, WORKSPACE_CHUNK_BYTES, WORKSPACE_CHUNK_BYTES + 1, 2 * WORKSPACE_CHUNK_BYTES + 12345]) {
      const plain = bytes(size);
      const sealed = await pipe(plain, sealWorkspace(raw, "owners/1/workspaces/a"), 7);
      expect(sealed.byteLength).toBe(sealedWorkspaceBytes(size));
      expect(openedWorkspaceBytes(sealed.byteLength)).toBe(size);
      expect(await digest(await pipe(sealed, openWorkspace(raw, "owners/1/workspaces/a"), 5))).toEqual(await digest(plain));
    }
  }, 30_000);

  it("rejects a changed byte, a dropped last chunk, another object's address and another key", async () => {
    const raw = await workspaceKey(key());
    const plain = bytes(2 * WORKSPACE_CHUNK_BYTES);
    const sealed = await pipe(plain, sealWorkspace(raw, "a"));
    const changed = sealed.slice(); changed[100] ^= 1;
    await expect(pipe(changed, openWorkspace(raw, "a"))).rejects.toThrow("failed authentication");
    await expect(pipe(sealed.slice(0, sealedWorkspaceBytes(WORKSPACE_CHUNK_BYTES)), openWorkspace(raw, "a"))).rejects.toThrow("failed authentication");
    await expect(pipe(sealed.slice(0, 20), openWorkspace(raw, "a"))).rejects.toThrow("truncated");
    await expect(pipe(sealed, openWorkspace(raw, "b"))).rejects.toThrow("failed authentication");
    await expect(pipe(sealed, openWorkspace(await workspaceKey(key()), "a"))).rejects.toThrow("failed authentication");
  }, 30_000);
});

describe("workspace save and restore", () => {
  it("stores the archive sealed and restores the same bytes into a new computer", async () => {
    const address = { objectKey: `test/owners/1000/workspaces/${crypto.randomUUID()}`, key: key() };
    const first = machine(), second = machine();
    try {
      first.fake.workspace = bytes(3 * WORKSPACE_CHUNK_BYTES + 99);
      expect(await saveWorkspace(first.connection, env.PROFILES, address)).toEqual({ bytes: first.fake.workspace.byteLength });
      expect(first.fake.commands[0]).toContain("tar -C /workspace -czf");
      const stored = await env.PROFILES.get(address.objectKey);
      expect(stored?.size).toBe(sealedWorkspaceBytes(first.fake.workspace.byteLength));
      const storedBytes = new Uint8Array(await stored!.arrayBuffer());
      expect(storedBytes.subarray(12, 44)).not.toEqual(first.fake.workspace.subarray(0, 32));
      second.fake.workspace = undefined;
      await restoreWorkspace(second.connection, env.PROFILES, address);
      expect(await digest(second.fake.workspace)).toEqual(await digest(first.fake.workspace));
      expect(second.fake.archive).toBeUndefined();
      expect(second.fake.commands.at(-1)).toContain("tar -C /workspace -xzf");
    } finally { first.close(); second.close(); await env.PROFILES.delete(address.objectKey); }
  }, 30_000);

  it("keeps polling a command the computer answers as still running", async () => {
    const address = { objectKey: `test/owners/1000/workspaces/${crypto.randomUUID()}`, key: key() };
    const first = machine(), second = machine();
    try {
      first.fake.slowCommands = true; second.fake.slowCommands = true;
      await saveWorkspace(first.connection, env.PROFILES, address);
      second.fake.workspace = undefined;
      await restoreWorkspace(second.connection, env.PROFILES, address);
      expect(second.fake.workspace).toEqual(first.fake.workspace);
      expect(first.fake.commands.filter(command => !command)).toHaveLength(1);
    } finally { first.close(); second.close(); await env.PROFILES.delete(address.objectKey); }
  });

  it("stores nothing when /workspace is missing or the archive is over the limit", async () => {
    const address = { objectKey: `test/owners/1000/workspaces/${crypto.randomUUID()}`, key: key() };
    const computer = machine();
    try {
      computer.fake.workspace = undefined;
      await expect(saveWorkspace(computer.connection, env.PROFILES, address)).rejects.toThrow("Workspace command failed");
      computer.fake.workspace = bytes(10);
      computer.fake.claimedSize = (1 << 30) + 1;
      await expect(saveWorkspace(computer.connection, env.PROFILES, address)).rejects.toThrow("larger than");
      expect(await env.PROFILES.head(address.objectKey)).toBeNull();
    } finally { computer.close(); }
  });

  it("fails a restore of a missing or foreign archive without unpacking anything", async () => {
    const address = { objectKey: `test/owners/1000/workspaces/${crypto.randomUUID()}`, key: key() };
    const source = machine(), target = machine();
    try {
      await expect(restoreWorkspace(target.connection, env.PROFILES, address)).rejects.toThrow("missing");
      await saveWorkspace(source.connection, env.PROFILES, address);
      target.fake.workspace = undefined;
      await expect(restoreWorkspace(target.connection, env.PROFILES, { ...address, key: key() })).rejects.toThrow("failed authentication");
      expect(target.fake.workspace).toBeUndefined();
      expect(target.fake.commands.some(command => command.includes("-xzf"))).toBe(false);
    } finally { source.close(); target.close(); await env.PROFILES.delete(address.objectKey); }
  });
});
