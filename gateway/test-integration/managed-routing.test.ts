import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createManagedGatewayTestHarness } from "./harness";

describe("managed installation routing integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedGatewayTestHarness();
    await harness.listen();
  });

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("returns 404 for an unknown wildcard hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/.well-known/oauth-client/gsv.json",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("returns 404 for an inactive installation", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://suspended.gsv.space/.well-known/oauth-client/gsv.json",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("does not expose public storage for an unknown hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/public/private-by-default.txt",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("serves each installation's public storage namespace", async () => {
    const worker = harness.getWorker<{ STORAGE: R2Bucket }>("gsv-managed");
    const { STORAGE } = await worker.getEnv();
    await Promise.all([
      putPublicAsset(STORAGE, "inst_integration_first", "first"),
      putPublicAsset(STORAGE, "inst_integration_second", "second"),
    ]);

    const first = await worker.fetch("https://first.gsv.space/public/installation.txt");
    const second = await worker.fetch("https://second.gsv.space/public/installation.txt");

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("first");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("second");
  });

  it("uses the directory's persisted canonical origin", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://first.gsv.space/.well-known/oauth-client/gsv.json",
    );
    const metadata = await response.json() as {
      client_id: string;
      redirect_uris: string[];
    };

    expect(response.status).toBe(200);
    expect(metadata.client_id).toBe(
      "https://first.gsv.space/.well-known/oauth-client/gsv.json",
    );
    expect(metadata.redirect_uris).toEqual([
      "https://first.gsv.space/oauth/callback",
    ]);
  });

  it("routes two accepted hostnames to independently initialized Kernels", async () => {
    for (const handle of ["first", "second"]) {
      const response = await harness.getWorker("gsv-managed").fetch(
        `https://${handle}.gsv.space/ws`,
        {
          headers: { Upgrade: "websocket" },
        },
      );
      expect(response.status).toBe(101);
      response.webSocket?.accept();
      response.webSocket?.close(1000, "test complete");
    }
  });
});

async function putPublicAsset(
  storage: R2Bucket,
  installationId: string,
  content: string,
): Promise<void> {
  await storage.put(
    `installations/${installationId}/public/installation.txt`,
    content,
    {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    },
  );
}
