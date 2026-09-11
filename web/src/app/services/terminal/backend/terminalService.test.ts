import { describe, expect, it, vi } from "vitest";
import { GSVClient, GsvClientError } from "@humansandmachines/gsv/client";
import { cancelTerminalCommand, executeTerminalCommand } from "./terminalService";
import { TerminalSessions } from "../terminalSessions";

describe("terminal service", () => {
  it("starts under the journaled identity with command options and never falls back to an unsafe start", async () => {
    const client = new GSVClient();
    const sessionId = crypto.randomUUID();
    const request = vi.spyOn(client, "request").mockResolvedValue({ data: { status: "running", sessionId, output: "" } });
    const command = { input: "  run once  ", target: "macbook", sessionId, start: true, cwd: "/tmp", timeoutMs: 20_000, background: true, yieldMs: 1_000 };
    await executeTerminalCommand(client, command);
    expect(request).toHaveBeenCalledWith("shell.exec", { input: "run once", target: "macbook", sessionId, start: true, cwd: "/tmp", timeout: 20_000, background: true, yieldMs: 1_000 }, { signal: undefined });
    request.mockRejectedValue(new GsvClientError({ code: 500, message: `Unknown shell session: ${sessionId}` }));
    await expect(executeTerminalCommand(client, command)).resolves.toMatchObject({ status: "failed", stderr: "Update GSV on this computer before running commands here." });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "offline before dispatch", code: 503, message: "Target offline: macbook" },
    { label: "missing implementation", code: 400, message: "Target macbook does not implement shell.exec" },
    { label: "legacy daemon", code: -1, message: null },
  ])("finishes a rejected start ($label) across reconnect and reload", async ({ code, message }) => {
    vi.useFakeTimers();
    const client = new GSVClient();
    const request = vi.spyOn(client, "request").mockRejectedValue(new Error("Unexpected request"));
    let journal: string | null = null;
    const storage = { read: () => journal, write: (value: string) => { journal = value; } };
    const operations = {
      execute: (input: Parameters<typeof executeTerminalCommand>[1], signal: AbortSignal) => executeTerminalCommand(client, input, signal),
      cancel: (id: string, signal: AbortSignal) => cancelTerminalCommand(client, id, signal),
    };
    const owner = new TerminalSessions(operations, storage);
    let restored: TerminalSessions | undefined;
    try {
      owner.setConnected(true);
      const id = owner.start("must not run", "macbook", "ship");
      const sessionId = owner.snapshot()[0].sessionId;
      request.mockRejectedValueOnce(new GsvClientError({ code, message: message ?? `Unknown shell session: ${sessionId}`,
        details: message ? { shellStart: "rejected" } : undefined,
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot()[0]).toMatchObject({ status: "failed", endedAt: expect.any(Number),
        error: message ?? "Update GSV on this computer before running commands here." });
      await owner.stop(id);
      owner.retry(id);
      owner.setConnected(false);
      owner.setConnected(true);
      owner.targetConnected("macbook");
      owner.dispose();
      restored = new TerminalSessions(operations, storage);
      restored.setConnected(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(restored.snapshot()[0]).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      owner.dispose();
      restored?.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    new Error("Connection closed"),
    new GsvClientError({ code: 503, message: "Device disconnected: macbook" }),
    new GsvClientError({ code: 504, message: "Request timed out" }),
    new GsvClientError({ code: 409, message: "Shell session already exists; poll it instead of starting it again" }),
  ])("preserves uncertain start failures for recovery: %s", async (error) => {
    const client = new GSVClient();
    const request = vi.spyOn(client, "request").mockRejectedValue(error);
    await expect(executeTerminalCommand(client, { input: "run once", target: "macbook", sessionId: crypto.randomUUID(), start: true })).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not turn a failed status check into a completed command", async () => {
    const client = new GSVClient();
    const sessionId = crypto.randomUUID();
    const error = new GsvClientError({ code: -1, message: `Unknown shell session: ${sessionId}` });
    vi.spyOn(client, "request").mockRejectedValue(error);
    await expect(executeTerminalCommand(client, { input: "", sessionId })).rejects.toBe(error);
  });
  it("sends stdin verbatim and consumes the incremental output field on terminal polls", async () => {
    const client = new GSVClient();
    const request = vi.spyOn(client, "request").mockResolvedValue({ data: {
      status: "completed", sessionId: "session", output: "new", stdout: "oldnew", stderr: "", exitCode: 0,
    } });
    const controller = new AbortController();
    const entry = await executeTerminalCommand(client, { sessionId: "session", input: " yes \n", yieldMs: 1_000 }, controller.signal);
    expect(request).toHaveBeenCalledWith("shell.exec", { sessionId: "session", input: " yes \n", yieldMs: 1_000 }, { signal: controller.signal });
    expect(entry.output).toBe("new");
    request.mockResolvedValue({ data: { status: "completed", sessionId: "session", output: "", stdout: "oldnew", exitCode: 0 } });
    expect((await executeTerminalCommand(client, { sessionId: "session", input: "" })).output).toBe("");
  });

  it("cancels through the explicit session operation", async () => {
    const client = new GSVClient();
    const request = vi.spyOn(client, "request").mockResolvedValue({ data: { sessionId: "session", cancelled: true } });
    await expect(cancelTerminalCommand(client, "session")).resolves.toEqual({ sessionId: "session", cancelled: true });
    expect(request).toHaveBeenCalledWith("shell.cancel", { sessionId: "session" }, { signal: undefined });
    request.mockRejectedValue(new GsvClientError({ code: 400, message: "Target macbook does not implement shell.cancel" }));
    await expect(cancelTerminalCommand(client, "session")).rejects.toThrow("Update GSV on this computer to use Stop.");
  });
});
