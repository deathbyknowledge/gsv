import { describe, expect, it } from "vitest";
import { pauseBrowserResources } from "./pause-access";

describe("pausing browser access", () => {
  it("revokes recording allowance before disconnecting and continues after a cleanup error", async () => {
    const calls: string[] = [];
    const result = await pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() {
        calls.push("stop network");
        throw new Error("network unavailable");
      },
      async stopRecordings() {
        calls.push("stop recordings");
        return [{}];
      },
      async releaseDebuggers() {
        calls.push("release debuggers");
        return [1, 2];
      },
    });

    expect(calls).toEqual(["revoke grant", "disconnect", "stop network", "stop recordings", "release debuggers"]);
    expect(result).toEqual({
      stoppedCaptures: 0,
      stoppedRecordings: 1,
      detachedTabs: 2,
      errors: ["network: Error: network unavailable"],
    });
  });

  it("still releases resources if saving the paused state fails", async () => {
    const calls: string[] = [];
    const result = await pauseBrowserResources({
      async disconnect() {
        calls.push("disconnect");
        throw new Error("storage unavailable");
      },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() { calls.push("stop network"); return []; },
      async stopRecordings() { calls.push("stop recordings"); return []; },
      async releaseDebuggers() { calls.push("release debuggers"); return []; },
    });

    expect(calls).toEqual(["revoke grant", "disconnect", "stop network", "stop recordings", "release debuggers"]);
    expect(result.errors).toEqual(["runtime state: Error: storage unavailable"]);
  });
});
