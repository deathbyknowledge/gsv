import { describe, expect, it } from "vitest";
import { resolveInstallationRoute } from "./routing";

describe("installation routing", () => {
  it("routes standalone requests to the fixed compatibility identity", async () => {
    await expect(
      resolveInstallationRoute(new Request("http://localhost:8787/ws")),
    ).resolves.toEqual({
      identity: {
        installationId: "singleton",
        canonicalOrigin: "http://localhost:8787",
      },
    });
  });
});
