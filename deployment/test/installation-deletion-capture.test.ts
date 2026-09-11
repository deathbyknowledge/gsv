import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureInstallationDeletionObjects, type DeletionCaptureAccounts, type DeletionCaptureArtifacts, type DeletionCaptureCloudflare,
  type DeletionCaptureConfiguration } from "../src/installation-deletion-capture.ts";
import { deletionCaptureClients, privateDeletionCaptureArtifacts } from "../src/installation-deletion-capture-command.ts";
import { installationDeletionEvidenceIndexSchema } from "../src/installation-deletion-resolver.ts";

const namespaceId = "a".repeat(32);
const id = (value: number) => value.toString(16).padStart(64, "0");
function fixture(count = 65) {
  let now = 1000;
  const configuration: DeletionCaptureConfiguration = { version: 1, accountId: "b".repeat(32), accountsOrigin: "https://accounts.example.invalid",
    installationId: "inst_retired", candidateInstallationIds: ["inst_retired", "inst_other"], namespaces: [{ namespaceId, ownerId: "gateway", className: "Process", kind: "process" }] };
  const files = new Map<string, string>();
  const artifacts: DeletionCaptureArtifacts = { read: async (reference) => files.get(reference) ?? null, write: async (reference, body) => {
    if (files.has(reference) && files.get(reference) !== body) throw new Error("Capture conflict");
    files.set(reference, body);
  } };
  const objects = Array.from({ length: count }, (_, index) => ({ id: id(index + 1), hasStoredData: true }));
  const listObjects = vi.fn<DeletionCaptureCloudflare["listObjects"]>(async ({ cursor }) => {
    const offset = Number(cursor ?? 0);
    const result = objects.slice(offset, offset + 33);
    return { success: true, result, result_info: { count: result.length, cursor: result.length ? String(offset + result.length) : "" } };
  });
  const openInspection = vi.fn<DeletionCaptureAccounts["openInspection"]>(async (installationId) => ({ id: crypto.randomUUID(), installationId, createdAt: ++now }));
  const inspect = vi.fn<DeletionCaptureAccounts["inspect"]>(async (input) => ({ installationId: input.installationId, inspectionEpochId: input.inspectionEpochId,
    observedAt: ++now, observations: input.resources.map((resource) => ({ ...resource, outcome: "identified", installationId: input.installationId, name: `process-${resource.objectId}` })) }));
  const clients = { cloudflare: { listObjects }, accounts: { openInspection, inspect } };
  const run = () => captureInstallationDeletionObjects({ configuration, ...clients, artifacts, clock: () => ++now });
  return { configuration, files, objects, listObjects, openInspection, inspect, clients, artifacts, run };
}

describe("operator DO evidence capture", () => {
  it("follows every cursor through the empty terminal page, inspects in32-object chunks, and emits hashed index parts", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({ scope: "durable-objects", outcome: "captured", storedObjects: 65, unidentifiedObjects: 0 });
    expect(f.listObjects.mock.calls.map(([input]) => input.cursor)).toEqual([null, "33", "65", null, "33", "65"]);
    expect(f.inspect.mock.calls.map(([input]) => input.resources.length)).toEqual([32, 32, 1]);
    const index = installationDeletionEvidenceIndexSchema.parse(JSON.parse(f.files.get(result.indexReference)!));
    expect(index.inspectionEpochId).toBe(result.inspectionEpochId);
    expect(index.namespaces[0].before.pages).toHaveLength(3);
    expect(index.namespaces[0].after.pages).toHaveLength(3);
    expect(result.evidence.every((part) => /^[a-f0-9]{64}$/.test(part.sha256) && Buffer.byteLength(part.body) <= 512 * 1024)).toBe(true);
    expect(result.resources).toHaveLength(65);
  });

  it("resumes an interrupted capture without reopening the epoch or probing successful chunks", async () => {
    const f = fixture();
    const original = f.inspect.getMockImplementation()!;
    let fail = true;
    f.inspect.mockImplementation(async (input) => {
      if (input.resources[0].objectId === id(33) && fail) { fail = false; throw new Error("interrupted"); }
      return original(input);
    });
    await expect(f.run()).rejects.toThrow("interrupted");
    const result = await f.run();
    expect(f.openInspection).toHaveBeenCalledTimes(1);
    expect(f.inspect.mock.calls.filter(([input]) => input.resources[0].objectId === id(1))).toHaveLength(1);
    expect(f.listObjects).toHaveBeenCalledTimes(6);
    const calls = f.inspect.mock.calls.length;
    expect(await f.run()).toEqual(result);
    expect(f.inspect).toHaveBeenCalledTimes(calls);
    expect(f.listObjects).toHaveBeenCalledTimes(6);
  });

  it("does not turn a changed namespace or wrong owner response into a completed index", async () => {
    const changed = fixture(1);
    const original = changed.listObjects.getMockImplementation()!;
    changed.listObjects.mockImplementation(async (input) => {
      const result = await original(input);
      if (changed.listObjects.mock.calls.length > 2) result.result = result.result.map((object) => ({ ...object, hasStoredData: false }));
      return result;
    });
    await expect(changed.run()).rejects.toThrow("enumeration changed");
    expect(changed.files.has("durable-objects-index.json")).toBe(false);
    const wrong = fixture(1);
    wrong.inspect.mockResolvedValue({ installationId: "another", inspectionEpochId: crypto.randomUUID(), observedAt: 2000, observations: [] });
    await expect(wrong.run()).rejects.toThrow("another scope");
    expect(wrong.files.has("durable-objects-index.json")).toBe(false);
  });

  it("retains unidentified objects as unresolved and skips physical objects without stored data", async () => {
    const f = fixture(2);
    f.objects[1].hasStoredData = false;
    f.inspect.mockImplementation(async (input) => ({ installationId: input.installationId, inspectionEpochId: input.inspectionEpochId,
      observations: input.resources.map((resource) => ({ ...resource, outcome: "unidentified" })), observedAt: 1002 }));
    expect(await f.run()).toMatchObject({ outcome: "captured", storedObjects: 1, unidentifiedObjects: 1, resources: [] });
    expect(f.inspect.mock.calls[0][0].resources).toHaveLength(1);
  });

  it("rejects a repeated cursor and changed resume configuration before opening an epoch", async () => {
    const repeated = fixture(65);
    repeated.listObjects.mockImplementation(async () => ({ success: true, result: [{ id: crypto.randomUUID().replaceAll("-", "").repeat(2), hasStoredData: false }], result_info: { count: 1, cursor: "same" } }));
    await expect(repeated.run()).rejects.toThrow("continuation cursor");
    expect(repeated.openInspection).not.toHaveBeenCalled();
    const resumed = fixture(0);
    await resumed.run();
    resumed.configuration.candidateInstallationIds.push("inst_new");
    await expect(resumed.run()).rejects.toThrow("conflict");
    expect(resumed.openInspection).toHaveBeenCalledTimes(1);
  });

  it("keeps authentication in headers, refuses redirects, and omits failed response contents", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("provider-secret", { status: 403 }));
    const clients = deletionCaptureClients({ accountId: "b".repeat(32), accountsOrigin: "https://accounts.example.invalid",
      cloudflareToken: "cloudflare-secret", operatorBearer: "operator-secret", fetch: transport });
    await expect(clients.cloudflare.listObjects({ accountId: "b".repeat(32), namespaceId, cursor: null, limit: 1000 })).rejects.toThrow("HTTP 403");
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer cloudflare-secret" } });
    await expect(clients.accounts.openInspection("inst_retired")).rejects.toThrow("HTTP 403");
    const headers = new Headers(transport.mock.calls[1][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer operator-secret");
    expect(headers.get("Origin")).toBe("https://accounts.example.invalid");
    expect(transport.mock.calls.every(([url]) => !String(url).includes("secret"))).toBe(true);
  });

  it("writes private immutable artifacts and refuses symlink files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gsv-do-capture-"));
    try {
      const artifacts = await privateDeletionCaptureArtifacts(directory);
      await artifacts.write("part.json", "{}");
      expect((await stat(path.join(directory, "part.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(directory, "part.json"), "utf8")).toBe("{}");
      await expect(artifacts.write("part.json", "[]")).rejects.toThrow("conflicts");
      await symlink(path.join(directory, "part.json"), path.join(directory, "link.json"));
      await expect(artifacts.read("link.json")).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});
