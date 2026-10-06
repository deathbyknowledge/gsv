import { describe, expect, it } from "vitest";
import { pauseBrowserResources } from "./pause-access";

describe("pausing browser access", () => {
  it("revokes recording allowance before disconnecting and continues after a cleanup error", async () => {
    const calls: string[] = [];
    let networkCalls = 0;
    let recordingCalls = 0;
    let debuggerCalls = 0;
    const result = await pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      async waitForCommands() { calls.push("wait for commands"); },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() {
        calls.push("stop network");
        if (networkCalls++ === 0) throw new Error("network unavailable");
        return [];
      },
      async stopRecordings() {
        calls.push("stop recordings");
        return recordingCalls++ === 0 ? [{}] : [];
      },
      async releaseDebuggers() {
        calls.push("release debuggers");
        return debuggerCalls++ === 0 ? [1, 2] : [];
      },
    });

    expect(calls).toEqual([
      "revoke grant", "disconnect", "stop network", "release debuggers", "stop recordings",
      "wait for commands", "stop network", "release debuggers", "stop recordings",
    ]);
    expect(result).toEqual({
      stoppedCaptures: 0,
      stoppedRecordings: 1,
      detachedTabs: 2,
      errors: ["network: Error: network unavailable"],
      commandsPending: false,
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

    expect(calls).toEqual([
      "revoke grant", "disconnect", "stop network", "release debuggers", "stop recordings",
      "wait for commands", "stop network", "release debuggers", "stop recordings",
    ]);
    expect(result.errors).toEqual(["runtime state: Error: storage unavailable"]);
    expect(result.commandsPending).toBe(false);
  });

  it("does not complete cleanup before owned commands finish", async () => {
    let finishCommand!: () => void;
    const command = new Promise<void>((resolve) => { finishCommand = resolve; });
    const calls: string[] = [];
    let debuggerPass = 0;
    const paused = pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      async waitForCommands() { calls.push("wait for commands"); await command; },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() { calls.push("stop network"); return []; },
      async stopRecordings() { calls.push("stop recordings"); return []; },
      async releaseDebuggers() { calls.push("release debuggers"); return debuggerPass++ === 0 ? [] : [42]; },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["revoke grant", "disconnect", "stop network", "release debuggers", "stop recordings", "wait for commands"]);
    finishCommand();
    const result = await paused;
    expect(calls).toEqual([
      "revoke grant", "disconnect", "stop network", "release debuggers", "stop recordings",
      "wait for commands", "stop network", "release debuggers", "stop recordings",
    ]);
    expect(result.detachedTabs).toBe(1);
  });

  it("returns a pending result after releasing resources when Chrome work does not settle", async () => {
    const calls: string[] = [];
    const result = await pauseBrowserResources({
      async disconnect() { calls.push("disconnect"); },
      async waitForCommands() { calls.push("wait for commands"); await new Promise<void>(() => {}); },
      revokeMediaGrant() { calls.push("revoke grant"); },
      async stopNetwork() { calls.push("stop network"); return []; },
      async stopRecordings() { calls.push("stop recordings"); return []; },
      async releaseDebuggers() { calls.push("release debuggers"); return [42]; },
    }, 5);

    expect(calls).toEqual(["revoke grant", "disconnect", "stop network", "release debuggers", "stop recordings", "wait for commands"]);
    expect(result.commandsPending).toBe(true);
    expect(result.detachedTabs).toBe(1);
    expect(result.errors).toEqual(["browser commands are still stopping; cleanup will continue when they finish"]);
  });
});
