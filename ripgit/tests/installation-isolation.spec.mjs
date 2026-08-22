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
