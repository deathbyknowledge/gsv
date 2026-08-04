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

  it("does not expose public installation storage for an unknown hostname", async () => {
    const response = await harness.getWorker("gsv-managed").fetch(
      "https://random.gsv.space/public/private-by-default.txt",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
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
