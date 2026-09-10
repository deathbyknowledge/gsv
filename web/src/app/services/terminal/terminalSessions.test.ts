import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/testHarness";
import { normalizeCommandInput, normalizeTranscriptEntry } from "./domain/normalization";
import { TerminalSessions, type TerminalOperations } from "./terminalSessions";

const owners: TerminalSessions[] = [];
const result = (output = "", status: "running" | "completed" | "failed" = "running") => normalizeTranscriptEntry({
  status, output, sessionId: "shell-session", exitCode: status === "running" ? null : status === "completed" ? 0 : 1,
}, Date.now(), normalizeCommandInput({ input: "" }));
function harness() {
  const execute = vi.fn<TerminalOperations["execute"]>(async () => result());
  const cancel = vi.fn<TerminalOperations["cancel"]>(async () => ({ sessionId: "shell-session", cancelled: true }));
  let journal: string | null = null;
  const storage = { read: () => journal, write: (value: string) => { journal = value; } };
  const owner = new TerminalSessions({ execute, cancel }, storage);
  owner.setConnected(true);
  owners.push(owner);
  return { owner, execute, cancel, storage, row: () => owner.snapshot()[0] };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers(); });

describe("direct shell session ownership", () => {
  it("keeps a running session live and appends incremental output until its terminal result", async () => {
    const { owner, execute, row } = harness();
    execute.mockResolvedValueOnce(result("first\n")).mockResolvedValueOnce(result("last\n", "completed"));
    owner.start("run tests", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    expect(row()).toMatchObject({ sessionId: "shell-session", status: "running", endedAt: null, output: "first\n" });
    await vi.advanceTimersByTimeAsync(250);
    expect(row()).toMatchObject({ status: "completed", output: "first\nlast\n" });
    expect(row().endedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("serializes input after the current poll, preserves newlines and retains newly typed input", async () => {
    const { owner, execute, row } = harness();
    const poll = deferred<ReturnType<typeof result>>();
    const input = deferred<ReturnType<typeof result>>();
    execute.mockResolvedValueOnce(result()).mockReturnValueOnce(poll.promise).mockReturnValueOnce(input.promise);
    const id = owner.start("read a line", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(250);
    owner.setDraft(id, " yes ");
    const sending = owner.sendInput(id);
    expect(await owner.sendInput(id)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    poll.resolve(result("prompt> "));
    await vi.advanceTimersByTimeAsync(0);
    expect(execute.mock.calls[2][0]).toEqual({ sessionId: "shell-session", input: " yes \n", yieldMs: 1_000 });
    owner.setDraft(id, "next line");
    input.resolve(result("accepted"));
    expect(await sending).toBe(true);
    expect(row().draft).toBe("next line");
  });

  it("stops the retained session after an outstanding poll and keeps all terminal output", async () => {
    const { owner, execute, cancel, row } = harness();
    const poll = deferred<ReturnType<typeof result>>();
    execute.mockResolvedValueOnce(result("first"));
    execute.mockReturnValueOnce(poll.promise).mockResolvedValue(result("last", "failed"));
    const id = owner.start("long command", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(250);
    const stopping = owner.stop(id);
    await owner.stop(id);
    expect(cancel).not.toHaveBeenCalled();
    expect(row().action).toBe("stop");
    poll.resolve(result("middle"));
    await stopping;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBe("shell-session");
    expect(row()).toMatchObject({ status: "stopped", output: "firstmiddlelast", action: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("retains an unsupported Stop error while the command continues to completion", async () => {
    const { owner, execute, cancel, row } = harness();
    cancel.mockRejectedValue(new Error("Target does not implement shell.cancel"));
    const id = owner.start("legacy machine command", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    await owner.stop(id);
    expect(row()).toMatchObject({ status: "running", endedAt: null, stopRequested: false, actionError: "Target does not implement shell.cancel" });
    execute.mockResolvedValue(result("done", "completed"));
    await vi.advanceTimersByTimeAsync(250);
    expect(row().status).toBe("completed");
  });

  it("can stop while a command is not consuming its stdin", async () => {
    const { owner, execute, cancel, row } = harness();
    execute.mockResolvedValueOnce(result()).mockImplementationOnce((_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).mockResolvedValue(result("", "failed"));
    const id = owner.start("blocked stdin", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    owner.setDraft(id, "unsent input");
    const sending = owner.sendInput(id);
    await vi.advanceTimersByTimeAsync(0);
    await owner.stop(id);
    expect(await sending).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "stopped", draft: "unsent input", action: null });
  });

  it("recovers when the machine reconnects before the old poll rejects", async () => {
    const { owner, execute, row } = harness();
    let reject!: (error: Error) => void;
    execute.mockResolvedValueOnce(result()).mockImplementationOnce(() => new Promise((_, failure) => { reject = failure; }))
      .mockResolvedValue(result("recovered", "completed"));
    owner.start("machine reconnect", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(250);
    owner.targetConnected("macbook");
    reject(new Error("old connection closed"));
    await vi.advanceTimersByTimeAsync(1);
    expect(row()).toMatchObject({ status: "completed", output: "recovered" });
  });

  it("does not send queued input after Stop supersedes it", async () => {
    const { owner, execute, cancel, row } = harness();
    execute.mockResolvedValueOnce(result()).mockImplementationOnce((_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).mockResolvedValue(result("", "failed"));
    const id = owner.start("waiting command", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(250);
    owner.setDraft(id, "do not send");
    const sending = owner.sendInput(id);
    await owner.stop(id);
    expect(await sending).toBe(false);
    expect(execute.mock.calls.some(([input]) => input.input === "do not send\n")).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "stopped", draft: "do not send", action: null });
  });

  it("does not overwrite a replacement owner's journal when an old request settles", async () => {
    const { owner, execute, storage } = harness();
    const pending = deferred<ReturnType<typeof result>>();
    execute.mockReturnValueOnce(pending.promise);
    owner.start("old command", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    owner.dispose();
    storage.write("replacement journal");
    pending.resolve(result("late output", "completed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.read()).toBe("replacement journal");
  });

  it("recovers a poll that rejects after the connection has already returned", async () => {
    const { owner, execute, row } = harness();
    let reject!: (error: Error) => void;
    execute.mockResolvedValueOnce(result("before"));
    execute.mockImplementationOnce(() => new Promise((_, failure) => { reject = failure; }));
    execute.mockResolvedValue(result("after", "completed"));
    owner.start("long command", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(250);
    owner.setConnected(false);
    expect(row()).toMatchObject({ status: "unavailable", sessionId: "shell-session", endedAt: null });
    owner.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);
    reject(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(250);
    expect(row()).toMatchObject({ status: "completed", output: "beforeafter" });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("does not replay uncertain input after reconnect and retains its draft", async () => {
    const { owner, execute, row } = harness();
    execute.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("connection lost"));
    const id = owner.start("read input", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    owner.setDraft(id, "one time only");
    expect(await owner.sendInput(id)).toBe(false);
    expect(row()).toMatchObject({ draft: "one time only", status: "unavailable" });
    expect(row().actionError).toContain("could not be confirmed");
    owner.setConnected(false);
    owner.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute.mock.calls.filter(([input]) => input.input === "one time only\n")).toHaveLength(1);
    expect(execute.mock.calls.at(-1)?.[0].input).toBe("");
  });

  it("retains session identity across views and restores it after reload without starting another command", async () => {
    const { owner, execute, cancel, storage } = harness();
    const listener = vi.fn();
    const unsubscribe = owner.subscribe(listener);
    owner.start("long command", "macbook", "helper");
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(250);
    expect(execute).toHaveBeenCalledTimes(2);
    owner.dispose();
    const restored = new TerminalSessions({ execute, cancel }, storage);
    owners.push(restored);
    restored.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(restored.snapshot()[0]).toMatchObject({ scope: "helper", command: "long command", sessionId: "shell-session", status: "running" });
    expect(execute.mock.calls.filter(([input]) => !input.sessionId)).toHaveLength(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a native foreground request and bounds retained output", async () => {
    const { owner, execute, row } = harness();
    execute.mockImplementationOnce((_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const id = owner.start("native command", "gsv", "ship");
    await vi.advanceTimersByTimeAsync(0);
    await owner.stop(id);
    expect(row().status).toBe("stopped");
    execute.mockResolvedValue(result("a".repeat(40_000), "completed"));
    owner.start("large output", "macbook", "ship");
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.snapshot()[1].output).toHaveLength(32_000);
    expect(owner.snapshot()[1].truncated).toBe(true);
  });
});
