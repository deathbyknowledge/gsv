import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INSTALLATION_HEADER = "x-gsv-installation-id";

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
    await expect(publicRepositoryHeads("inst_first")).resolves.toEqual({
      main: firstHead,
    });
    await expect(repositoryHeads("inst_second")).resolves.toEqual({});
  });

  it("rejects a missing routing header before allocating a Repository", async () => {
    for (const path of ["/alice/home/refs", "/hyperspace/repos/alice/home/refs"]) {
      const response = await miniflare.dispatchFetch(`http://ripgit${path}`);
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe("Missing installation routing header");
    }
    await expect(repositoryHeads("inst_missing_header_control")).resolves.toEqual({});
  });

  it("rejects malformed installation routing metadata", async () => {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/hyperspace/repos/alice/home/refs",
      { headers: { [INSTALLATION_HEADER]: "../other" } },
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid installation routing header");
  });

  async function createRepository(installationId) {
    const headers = { "content-type": "application/json" };
    if (installationId) {
      headers[INSTALLATION_HEADER] = installationId;
    }
    const response = await miniflare.dispatchFetch(
      "http://ripgit/hyperspace/repos/alice/home/apply",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          defaultBranch: "main",
          author: "alice",
          email: "alice@gsv.local",
          message: "initialize repository",
          ops: [],
          allowEmpty: true,
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

  async function publicRepositoryHeads(installationId) {
    const response = await miniflare.dispatchFetch(
      "http://ripgit/alice/home/refs",
      { headers: { [INSTALLATION_HEADER]: installationId } },
    );
    expect(response.status).toBe(200);
    return (await response.json()).heads;
  }
});
