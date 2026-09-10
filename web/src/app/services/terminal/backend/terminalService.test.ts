import { describe, expect, it, vi } from "vitest";
import { GSVClient, GsvClientError } from "@humansandmachines/gsv/client";
import { cancelTerminalCommand, executeTerminalCommand } from "./terminalService";

describe("terminal service", () => {
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
