import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INSTALLATION_HEADER = "x-gsv-installation-id";
const execFileAsync = promisify(execFile);

describe("Repository installation isolation", () => {
  let miniflare;

  beforeAll(() => {
    miniflare = new Miniflare({
      modules: true,
      modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
      scriptPath: "build/index.js",
      modulesRoot: "build",
      compatibilityDate: "2026-03-18",
      durableObjects: {
        REPOSITORY: { className: "Repository", useSQLite: true },
      },
      durableObjectsPersist: false,
    });
  });

  afterAll(async () => {
    await miniflare.dispose();
  });

  it("keeps identical managed repository slugs in different Durable Objects", async () => {
    const firstHead = await createRepository("inst_first");

    await expect(repositoryHeads("inst_first")).resolves.toEqual({
      main: firstHead,
    });
    await expect(repositoryHeads("inst_second")).resolves.toEqual({});

    const firstBundle = await repositoryBundle("inst_first");
    expect(firstBundle.header).toContain(`${firstHead} refs/heads/main\n`);
    expect([...firstBundle.pack.slice(0, 4)]).toEqual([80, 65, 67, 75]);
    const secondBundle = await repositoryBundle("inst_second");
    expect(secondBundle.header).not.toContain(firstHead);
  });

  it("maps a missing header and singleton to the historical Repository object", async () => {
    const legacyHead = await createRepository();

    await expect(repositoryHeads("singleton")).resolves.toEqual({
      main: legacyHead,
    });
  });

  it("rejects malformed installation routing metadata", async () => {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/hyperspace/repos/alice/home/refs",
      { headers: { [INSTALLATION_HEADER]: "../other" } },
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid installation routing header");
  });

  it("requires an authenticated actor for repository bundle export", async () => {
    await createRepository("inst_bundle_auth");
    const response = await miniflare.dispatchFetch(
      "http://ripgit/alice/home/bundle",
      { headers: { [INSTALLATION_HEADER]: "inst_bundle_auth" } },
    );
    expect(response.status).toBe(401);
  });

  it("produces a self-contained bundle accepted by Git", async () => {
    const expectedHead = await createRepository("inst_bundle_clone");
    const bundle = await repositoryBundle("inst_bundle_clone");
    const directory = await mkdtemp(join(tmpdir(), "gsv-ripgit-bundle-"));
    try {
      const bundlePath = join(directory, "repository.bundle");
      const checkoutPath = join(directory, "checkout");
      await writeFile(bundlePath, bundle.bytes);
      await execFileAsync("git", [
        "clone",
        "--quiet",
        "--branch",
        "main",
        bundlePath,
        checkoutPath,
      ]);
      const head = await execFileAsync("git", ["-C", checkoutPath, "rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(expectedHead);
      await expect(readFile(join(checkoutPath, "export-proof.txt"), "utf8"))
        .resolves.toBe("ripgit export proof\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function createRepository(installationId) {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/hyperspace/repos/alice/home/apply",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(installationId ? { [INSTALLATION_HEADER]: installationId } : {}),
        },
        body: JSON.stringify({
          defaultBranch: "main",
          author: "alice",
          email: "alice@gsv.local",
          message: "initialize repository",
          ops: [{
            type: "put",
            path: "export-proof.txt",
            contentBytes: [...new TextEncoder().encode("ripgit export proof\n")],
          }],
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    expect(result.head).toEqual(expect.any(String));
    return result.head;
  }

  async function repositoryHeads(installationId) {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/hyperspace/repos/alice/home/refs",
      { headers: { [INSTALLATION_HEADER]: installationId } },
    );
    expect(response.status).toBe(200);
    return (await response.json()).heads;
  }

  async function repositoryBundle(installationId) {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/alice/home/bundle",
      {
        headers: {
          [INSTALLATION_HEADER]: installationId,
          "x-ripgit-actor-name": "root",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-bundle");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
    const boundary = findDoubleNewline(bytes);
    expect(boundary).toBeGreaterThan(0);
    return {
      bytes,
      header: new TextDecoder().decode(bytes.slice(0, boundary + 2)),
      pack: bytes.slice(boundary + 2),
    };
  }
});

function findDoubleNewline(bytes) {
  for (let index = 0; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return index;
  }
  return -1;
}
