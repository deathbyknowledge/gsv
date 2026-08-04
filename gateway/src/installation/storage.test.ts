import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationId, LEGACY_STANDALONE_INSTALLATION_ID } from "./identity";
import {
  createInstallationStorage,
  installationStorageKey,
  installationStoragePrefix,
} from "./storage";

const cleanupPrefixes = new Set<string>();

afterEach(async () => {
  for (const prefix of cleanupPrefixes) {
    let cursor: string | undefined;
    do {
      const listed = await env.STORAGE.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await env.STORAGE.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  cleanupPrefixes.clear();
});

describe("installation R2 storage", () => {
  it("preserves all existing standalone keys", () => {
    expect(installationStoragePrefix(LEGACY_STANDALONE_INSTALLATION_ID)).toBe("");
    expect(installationStorageKey(
      LEGACY_STANDALONE_INSTALLATION_ID,
      "home/alice/file.txt",
    )).toBe("home/alice/file.txt");
    expect(createInstallationStorage(
      env.STORAGE,
      LEGACY_STANDALONE_INSTALLATION_ID,
    )).toBe(env.STORAGE);
  });

  it("isolates identical logical keys between managed installations", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const firstPrefix = installationStoragePrefix(firstId);
    const secondPrefix = installationStoragePrefix(secondId);
    cleanupPrefixes.add(firstPrefix);
    cleanupPrefixes.add(secondPrefix);
    const first = createInstallationStorage(env.STORAGE, firstId);
    const second = createInstallationStorage(env.STORAGE, secondId);

    await first.put("home/alice/file.txt", "first");
    await second.put("home/alice/file.txt", "second");

    expect(await (await first.get("home/alice/file.txt"))?.text()).toBe("first");
    expect(await (await second.get("home/alice/file.txt"))?.text()).toBe("second");
    expect(await (await env.STORAGE.get(`${firstPrefix}home/alice/file.txt`))?.text())
      .toBe("first");
    expect(await (await env.STORAGE.get(`${secondPrefix}home/alice/file.txt`))?.text())
      .toBe("second");
    expect(await env.STORAGE.head("home/alice/file.txt")).toBeNull();

    expect((await first.list({ prefix: "home/" })).objects.map((object) => object.key))
      .toEqual(["home/alice/file.txt"]);
    await first.delete("home/alice/file.txt");
    expect(await first.head("home/alice/file.txt")).toBeNull();
    expect(await (await second.get("home/alice/file.txt"))?.text()).toBe("second");
  });

  it("maps list results back to logical keys and prefixes", async () => {
    const installationId = createInstallationId();
    const physicalPrefix = installationStoragePrefix(installationId);
    cleanupPrefixes.add(physicalPrefix);
    const storage = createInstallationStorage(env.STORAGE, installationId);
    await storage.put("home/alice/a.txt", "a");
    await storage.put("home/bob/b.txt", "b");

    const recursive = await storage.list({ prefix: "home/" });
    expect(recursive.objects.map((object) => object.key).sort()).toEqual([
      "home/alice/a.txt",
      "home/bob/b.txt",
    ]);

    const delimited = await storage.list({ prefix: "home/", delimiter: "/" });
    expect(delimited.objects).toEqual([]);
    expect(delimited.delimitedPrefixes.sort()).toEqual(["home/alice/", "home/bob/"]);
  });

  it("maps returned object keys without changing object body behavior", async () => {
    const installationId = createInstallationId();
    const physicalPrefix = installationStoragePrefix(installationId);
    cleanupPrefixes.add(physicalPrefix);
    const storage = createInstallationStorage(env.STORAGE, installationId);

    const written = await storage.put("tmp/result.txt", "hello");
    const read = await storage.get("tmp/result.txt");

    expect(written.key).toBe("tmp/result.txt");
    expect(read?.key).toBe("tmp/result.txt");
    expect(await read?.text()).toBe("hello");
  });

  it("scopes multipart creation and resume while exposing logical keys", async () => {
    const installationId = createInstallationId();
    const prefix = installationStoragePrefix(installationId);
    const createMultipartUpload = vi.fn(async (key: string) => multipartUpload(key));
    const resumeMultipartUpload = vi.fn((key: string, uploadId: string) => (
      multipartUpload(key, uploadId)
    ));
    const storage = createInstallationStorage({
      createMultipartUpload,
      resumeMultipartUpload,
    } as unknown as R2Bucket, installationId);

    const created = await storage.createMultipartUpload("tmp/large.bin");
    const resumed = storage.resumeMultipartUpload("tmp/large.bin", "upload-1");

    expect(createMultipartUpload).toHaveBeenCalledWith(
      `${prefix}tmp/large.bin`,
      undefined,
    );
    expect(resumeMultipartUpload).toHaveBeenCalledWith(
      `${prefix}tmp/large.bin`,
      "upload-1",
    );
    expect(created.key).toBe("tmp/large.bin");
    expect(resumed.key).toBe("tmp/large.bin");
  });
});

function multipartUpload(key: string, uploadId = "upload-1"): R2MultipartUpload {
  return {
    key,
    uploadId,
    uploadPart: vi.fn(),
    abort: vi.fn(),
    complete: vi.fn(),
  } as unknown as R2MultipartUpload;
}
