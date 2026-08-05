import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SINGLETON_INSTALLATION_ID } from "./identity";
import {
  createInstallationStorage,
  installationStoragePrefix,
} from "./storage";

const cleanupPrefixes = new Set<string>();

afterEach(async () => {
  for (const prefix of cleanupPrefixes) {
    let cursor: string | undefined;
    do {
      const result = await env.STORAGE.list({ prefix, cursor });
      if (result.objects.length > 0) {
        await env.STORAGE.delete(result.objects.map((object) => object.key));
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
  }
  cleanupPrefixes.clear();
});

describe("installation R2 storage", () => {
  it("preserves the standalone keyspace", () => {
    expect(installationStoragePrefix(SINGLETON_INSTALLATION_ID)).toBe("");
    expect(createInstallationStorage(env.STORAGE, SINGLETON_INSTALLATION_ID))
      .toBe(env.STORAGE);
  });

  it("isolates identical logical keys between installations", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const firstPrefix = track(firstId);
    const secondPrefix = track(secondId);
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

  it("maps list results and options to the logical namespace", async () => {
    const installationId = createInstallationId();
    track(installationId);
    const storage = createInstallationStorage(env.STORAGE, installationId);
    await storage.put("home/alice/a.txt", "a");
    await storage.put("home/alice/b.txt", "b");
    await storage.put("home/bob/c.txt", "c");

    const after = await storage.list({
      prefix: "home/alice/",
      startAfter: "home/alice/a.txt",
    });
    expect(after.objects.map((object) => object.key)).toEqual(["home/alice/b.txt"]);

    const delimited = await storage.list({ prefix: "home/", delimiter: "/" });
    expect(delimited.objects).toEqual([]);
    expect(delimited.delimitedPrefixes.sort()).toEqual(["home/alice/", "home/bob/"]);
  });

  it("maps returned object keys without changing body behavior", async () => {
    const installationId = createInstallationId();
    track(installationId);
    const storage = createInstallationStorage(env.STORAGE, installationId);

    const written = await storage.put("tmp/result.txt", "hello", {
      httpMetadata: { contentType: "text/plain" },
    });
    const head = await storage.head("tmp/result.txt");
    const read = await storage.get("tmp/result.txt");

    expect(written.key).toBe("tmp/result.txt");
    expect(head?.key).toBe("tmp/result.txt");
    expect(read?.key).toBe("tmp/result.txt");
    expect(await read?.text()).toBe("hello");
    const headers = new Headers();
    read?.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/plain");
  });

  it("scopes multipart uploads while exposing logical keys", async () => {
    const installationId = createInstallationId();
    const prefix = track(installationId);
    const createMultipartUpload = vi.fn(
      async (key: string, _options?: R2MultipartOptions) => multipartUpload(key),
    );
    const resumeMultipartUpload = vi.fn(
      (key: string, uploadId: string) => multipartUpload(key, uploadId),
    );
    const bucket = new Proxy(env.STORAGE, {
      get(target, property) {
        if (property === "createMultipartUpload") {
          return createMultipartUpload;
        }
        if (property === "resumeMultipartUpload") {
          return resumeMultipartUpload;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = createInstallationStorage(bucket, installationId);

    const created = await storage.createMultipartUpload("tmp/large.bin");
    const resumed = storage.resumeMultipartUpload("tmp/large.bin", "upload-2");
    const completed = await created.complete([]);

    expect(createMultipartUpload).toHaveBeenCalledWith(
      `${prefix}tmp/large.bin`,
      undefined,
    );
    expect(resumeMultipartUpload).toHaveBeenCalledWith(
      `${prefix}tmp/large.bin`,
      "upload-2",
    );
    expect(created.key).toBe("tmp/large.bin");
    expect(resumed.key).toBe("tmp/large.bin");
    expect(completed.key).toBe("tmp/large.bin");
  });
});

function createInstallationId(): string {
  return `inst_${crypto.randomUUID()}`;
}

function track(installationId: string): string {
  const prefix = installationStoragePrefix(installationId);
  cleanupPrefixes.add(prefix);
  return prefix;
}

function multipartUpload(key: string, uploadId = "upload-1"): R2MultipartUpload {
  return {
    key,
    uploadId,
    async uploadPart(partNumber) {
      return { partNumber, etag: "test-etag" };
    },
    async abort() {},
    async complete() {
      return env.STORAGE.put(key, "complete");
    },
  };
}
