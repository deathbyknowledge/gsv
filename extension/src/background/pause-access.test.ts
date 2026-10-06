import { describe, expect, it } from "vitest";
import { pauseBrowserResources } from "./pause-access";

describe("pausing browser access", () => {
  it("revokes recording allowance before disconnecting and continues after a cleanup error", async () => {
    const calls: string[] = [];
    const result = await pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      async waitForCommands() { calls.push("wait for commands"); },
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

    expect(calls).toEqual(["revoke grant", "disconnect", "wait for commands", "stop network", "stop recordings", "release debuggers"]);
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
      async waitForCommands() { calls.push("wait for commands"); },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() { calls.push("stop network"); return []; },
      async stopRecordings() { calls.push("stop recordings"); return []; },
      async releaseDebuggers() { calls.push("release debuggers"); return []; },
    });

    expect(calls).toEqual(["revoke grant", "disconnect", "wait for commands", "stop network", "stop recordings", "release debuggers"]);
    expect(result.errors).toEqual(["runtime state: Error: storage unavailable"]);
  });

  it("does not complete cleanup before owned commands finish", async () => {
    let finishCommand!: () => void;
    const command = new Promise<void>((resolve) => { finishCommand = resolve; });
    const calls: string[] = [];
    const paused = pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      async waitForCommands() { calls.push("wait for commands"); await command; },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() { calls.push("stop network"); return []; },
      async stopRecordings() { calls.push("stop recordings"); return []; },
      async releaseDebuggers() { calls.push("release debuggers"); return []; },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["revoke grant", "disconnect", "wait for commands"]);
    finishCommand();
    await paused;
    expect(calls).toEqual(["revoke grant", "disconnect", "wait for commands", "stop network", "stop recordings", "release debuggers"]);
  });
});
