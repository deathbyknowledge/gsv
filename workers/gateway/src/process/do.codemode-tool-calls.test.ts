import { Kernel } from "../kernel/do";
import type { ResponseOkFrame } from "../protocol/frames";
import { stableOpaqueId } from "../shared/stable-id";
import { getKernelPtr } from "../shared/utils";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  approvedRun, deferred, okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq,
  registerToolBlock, terminalTestConfig, type ProcessTestValue,
} from "./do-test-harness";

function startCancellableCodeModeRun(process: any, requestId: string) {
  const started = deferred();
  process.tools.handleCodeModeRun = async (_args: ProcessTestValue, signal: AbortSignal) => {
    started.resolve();
    return await new Promise((resolve) => {
      const abort = () => resolve({
        status: "failed",
        error: signal.reason instanceof Error ? signal.reason.message : "Request cancelled",
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const execution = process.recvFrame({
    type: "req",
    id: requestId,
    call: "codemode.run",
    args: {
      code: "return 'done';",
    },
  });
  return { execution, started: started.promise };
}

describe("CodeMode tool calls", () => {
  it("runs codemode from the native shell command", async () => {
    const pid = "mech-codemode-shell";
    await initProcess(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          pid,
          makeReq("shell.exec", {
            input: "codemode -e 'return { argv, args };' --json --arg mode=check -- alpha",
            // SAFETY: test fixture is constructed with the asserted domain shape.
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    expect(response.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = response.data as any;
    expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
    expect(data.exitCode).toBe(0);
    expect(JSON.parse(data.stdout)).toEqual({
      status: "completed",
      result: {
        argv: ["alpha"],
        // SAFETY: test fixture is constructed with the asserted domain shape.
        args: { mode: "check" },
      },
    });
  });

  it("runs codemode script files from the native shell command", async () => {
    const pid = "mech-codemode-shell-file";
    await initProcess(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          pid,
          makeReq("shell.exec", {
            input: [
              "echo '{\"ok\":true}' > test.json",
              "cat > test.js <<'EOF'",
              'const res = await shell("pwd");',
              'const file = await fs.read({ path: "test.json" });',
              "return { res, file, argv, args};",
              // SAFETY: test fixture is constructed with the asserted domain shape.
              "EOF",
              "codemode run test.js --json --arg mode=file -- beta",
            ].join("\n"),
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    expect(response.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = response.data as any;
    expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
    expect(data.exitCode).toBe(0);
    const result = JSON.parse(data.stdout);
    expect(result.status).toBe("completed");
    expect(result.result.argv).toEqual(["beta"]);
    expect(result.result.args).toEqual({ mode: "file" });
    expect(result.result.res.output).toContain("/root");
    expect(result.result.file.content).toContain('"ok":true');
  });

  it("lets process-local codemode read its own /proc history view", async () => {
    const pid = "mech-codemode-self-proc-view";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, (process) => {
      const store = process.store;
      store.messages.appendMessage("user", "hello from history");
      store.messages.appendMessage("assistant", "hello back");
    });

    const res = await okProcessResponse(
      stub,
      makeReq("codemode.run", {
        code: [
          'const file = await fs.read({ target: "gsv", path: "/proc/self/history" });',
          "if (!file.ok) throw new Error(file.error);",
          "return file.content;",
          // SAFETY: test fixture is constructed with the asserted domain shape.
        ].join("\n"),
      }),
    );

    expect(res.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = res.data as any;
    expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
    expect(data.result).toContain('"role":"user"');
    expect(data.result).toContain("hello from history");
    expect(data.result).toContain('"role":"assistant"');
    expect(data.result).toContain("hello back");
  });

  it("returns failed json for malformed codemode eval source", async () => {
    const pid = "mech-codemode-shell-syntax-error";
    await initProcess(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          pid,
          makeReq("shell.exec", {
            input: "codemode -e 'const res = await shell(\"pwd);' --json",
            // SAFETY: test fixture is constructed with the asserted domain shape.
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    expect(response.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = response.data as any;
    expect(data.status, JSON.stringify(data, null, 2)).toBe("failed");
    expect(data.exitCode).toBe(1);
    const result = JSON.parse(data.stdout);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("SyntaxError");
    expect(result.error).toContain("Invalid or unexpected token");
  });

  it("runs codemode.run as a process command", async () => {
    const pid = "mech-codemode-run";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const res = await okProcessResponse(
      stub,
      makeReq("codemode.run", {
        code: "return { argv, args };",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        argv: ["alpha"],
        args: { mode: "manual" },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      status: "completed",
      result: {
        argv: ["alpha"],
        args: { mode: "manual" },
      },
    });
  });

  it("cancels a direct codemode.run request", async () => {
    const pid = "mech-codemode-run-cancel";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const requestId = "codemode-cancel-1";
      const run = startCancellableCodeModeRun(process, requestId);

      await run.started;
      await process.recvFrame({
        type: "sig",
        signal: REQUEST_CANCEL_SIGNAL,
        payload: { id: requestId, reason: "new user message" },
      });
      const response = await run.execution;

      expect(response).toMatchObject({
        type: "res",
        id: requestId,
        ok: true,
        data: { status: "failed", error: "new user message" },
      });
    });
  });

  it("cancels a direct codemode.run when the process resets", async () => {
    const pid = "mech-codemode-run-reset";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const run = startCancellableCodeModeRun(process, "codemode-reset-1");

      await run.started;
      const reset = await process.recvFrame(makeReq("proc.reset", {}));
      const response = await run.execution;

      expect(reset).toMatchObject({ ok: true, data: { ok: true, pid } });
      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "failed",
          error: "Process execution was reset: process.reset",
        },
      });
    });
  });

  it("gates CodeMode fetches through tool approval", async () => {
    const pid = "mech-codemode-fetch-approval";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const approvals: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
      let dispatched = false;

      process.runs.active = {
        runId: "run-codemode-fetch-approval",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "net.fetch", action: "ask" }],
        },
      };
      process.tools.waitForCodeModeApproval = async (
        _runId: string,
        _dispatchId: string,
        _toolCallId: string,
        _toolName: string,
        call: string,
        args: Record<string, ProcessTestValue>,
      ) => {
        approvals.push({ call, args });
        return false;
      };
      process.tools.dispatchCodeModeSyscall = async () => {
        dispatched = true;
        throw new Error("unexpected dispatch");
      };

      await expect(
        process.tools.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-approval",
            dispatchId: "dispatch-codemode-fetch-approval",
            approvalPolicy: process.runs.active.approvalPolicy,
            capabilities: ["net.fetch"],
          },
          "net.fetch",
          {
            url: "https://example.com/upload",
            method: "POST",
            headers: {},
            bodyBase64: btoa("secret"),
          },
        ),
      ).rejects.toThrow("Tool execution was not approved: net.fetch");

      expect(approvals).toEqual([
        {
          call: "net.fetch",
          args: {
            url: "https://example.com/upload",
            method: "POST",
            headers: {},
            bodyBase64: btoa("secret"),
          },
        },
      ]);
      expect(dispatched).toBe(false);
    });
  });

  it("rejects unavailable CodeMode syscalls before approval", async () => {
    const stub = await initProcess("mech-codemode-fetch-capability", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      let requestedApproval = false;
      let dispatched = false;
      process.runs.active = {
        runId: "run-codemode-fetch-capability",
      };
      process.tools.waitForCodeModeApproval = async () => {
        requestedApproval = true;
        return true;
      };
      process.tools.dispatchCodeModeSyscall = async () => {
        dispatched = true;
      };

      await expect(
        process.tools.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-capability",
            dispatchId: "dispatch-codemode-fetch-capability",
            approvalPolicy: {
              default: "ask",
              rules: [],
            },
            capabilities: ["codemode.*"],
          },
          "net.fetch",
          { url: "https://example.com/" },
        ),
      ).rejects.toThrow("Permission denied: net.fetch");

      expect(requestedApproval).toBe(false);
      expect(dispatched).toBe(false);
    });
  });

  it("gates nested CodeMode mail sends through ordinary Process approval", async () => {
    const stub = await initProcess("mech-codemode-mail-approval", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const approvals: Array<{
        toolName: string;
        call: string;
        args: Record<string, ProcessTestValue>;
      }> = [];
      let dispatched = false;
      process.runs.active = { runId: "run-codemode-mail-approval" };
      process.tools.waitForCodeModeApproval = async (
        _runId: string,
        _dispatchId: string,
        _toolCallId: string,
        toolName: string,
        call: string,
        args: Record<string, ProcessTestValue>,
      ) => {
        approvals.push({ toolName, call, args });
        return false;
      };
      process.tools.dispatchCodeModeSyscall = async () => {
        dispatched = true;
        throw new Error("unexpected dispatch");
      };

      await expect(
        process.tools.executeCodeModeSyscall(
          {
            runId: "run-codemode-mail-approval",
            dispatchId: "dispatch-codemode-mail-approval",
            approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
            capabilities: ["mail.send"],
          },
          "mail.send",
          {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: "mail-send:approval:1",
          },
        ),
      ).rejects.toThrow("Tool execution was not approved: mail.send");

      expect(approvals).toEqual([
        {
          toolName: "mail.send",
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: "mail-send:approval:1",
          },
        },
      ]);
      expect(dispatched).toBe(false);
    });
  });

  it("ignores a nested CodeMode result after the run stops", async () => {
    const pid = "mech-codemode-fetch-stopped-after-fetch";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      let stopChecks = 0;

      process.runs.active = {
        runId: "run-codemode-fetch-stopped-after-fetch",
        config: {
          ...terminalTestConfig(pid),
          capabilities: ["codemode.*", "net.fetch"],
        },
        approvalPolicy: {
          default: "auto",
          rules: [],
        },
      };
      process.handleRunStopped = () => {
        stopChecks += 1;
        return stopChecks >= 3;
      };
      process.tools.dispatchCodeModeSyscall = async () => ({
        type: "res",
        id: "codemode-result",
        ok: true,
        data: { status: 200 },
      });

      await expect(
        process.tools.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-stopped-after-fetch",
            dispatchId: "dispatch-codemode-fetch-stopped-after-fetch",
            approvalPolicy: process.runs.active.approvalPolicy,
            capabilities: ["net.fetch"],
          },
          "net.fetch",
          {
            url: "https://example.com/",
            method: "GET",
            headers: {},
          },
        ),
      ).rejects.toThrow("Run stopped before CodeMode tool execution completed");
    });
  });

  it("rejects codemode.run fetches without net.fetch capability", async () => {
    const pid = "mech-codemode-run-fetch-capability";
    const identity: ProcessIdentity = {
      uid: 3000,
      gid: 3000,
      gids: [3000],
      username: "limited",
      home: "/home/limited",
      cwd: "/home/limited",
    };
    const stub = await initProcess(pid, identity);
    const kernel = await getKernelPtr();
    // SAFETY: test fixture is constructed with the asserted domain shape.
    await runInDurableObject(kernel, (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const k = instance as any;
      k.caps.grant(3000, "codemode.run");
    });

    await runInProcess(stub, async (process) => {
      const result = await process.tools.handleCodeModeRun({
        code: "const response = await fetch('https://example.com/'); return response.status;",
      });

      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Permission denied: net.fetch"),
      });
    });
  });

  it("dispatches CodeMode through the process-local executor path", async () => {
    const pid = "mech-codemode-basic";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.runs.active = approvedRun("run-codemode-basic");
      process.sendSignal = async () => {};
      const background: Promise<unknown>[] = [];
      process.startBackground = (_label: string, operation: Promise<unknown>) => {
        background.push(operation);
      };
      process.tools.executeCodeModeTool = async (
        runId: string,
        dispatchId: string,
        args: { code: string },
      ) => {
        expect(runId).toBe("run-codemode-basic");
        expect(dispatchId).toBe("dispatch-call-codemode-1");
        expect(args.code).toContain("fs.read");
        process.store.tools.resolve(dispatchId, {
          status: "completed",
          result: "from codemode",
        });
      };

      registerToolBlock(process, "run-codemode-basic", [
        {
          type: "toolCall",
          id: "call-codemode-1",
          name: "CodeMode",
          arguments: {
            code: `
              const file = await fs.read({ target: "gsv", path: "/tmp/example.txt" });
              return file.content;
            `,
          },
        },
      ]);
      await process.tools.processToolCalls("run-codemode-basic");
      await Promise.all(background);

      expect(process.store.tools.getResults("run-codemode-basic")).toEqual([
        expect.objectContaining({
          id: "call-codemode-1",
          call: "codemode.exec",
          status: "completed",
          result: {
            status: "completed",
            result: "from codemode",
          },
        }),
      ]);
    });
  });

  it("derives nested mail delivery ids from the durable model execution", async () => {
    const pid = "mech-codemode-mail-delivery";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-codemode-mail-delivery";
      const dispatchId = "dispatch-call-codemode-mail-delivery";
      const calls: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
      process.runs.active = {
        runId,
        config: {
          ...terminalTestConfig(pid),
          capabilities: ["mail.send"],
        },
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.tools.resumeResolvedToolRun = async () => {};
      process.tools.getCodeModeMcpToolBindings = async () => [];
      process.tools.executeCodeModeSyscall = async (
        _context: ProcessTestValue,
        call: string,
        args: Record<string, ProcessTestValue>,
      ) => {
        calls.push({ call, args });
        return { ok: true, deliveryId: args.deliveryId };
      };
      registerToolBlock(process, runId, [
        {
          type: "toolCall",
          id: "call-codemode-mail-delivery",
          name: "CodeMode",
          arguments: {
            code: `return await mail.send({ to: "mike@example.com", text: "Hello" });`,
          },
        },
      ]);
      process.store.tools.markDispatched(dispatchId);

      await process.tools.executeCodeModeTool(
        runId,
        dispatchId,
        { code: `return await mail.send({ to: "mike@example.com", text: "Hello" });` },
        process.runs.active.approvalPolicy,
      );

      const deliveryBase = await stableOpaqueId("mail-send", [
        process.installationId,
        pid,
        runId,
        dispatchId,
      ]);
      expect(calls).toEqual([
        {
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: `${deliveryBase}:1`,
          },
        },
      ]);
    });
  });

  it("derives manual CodeMode mail delivery ids from the request frame", async () => {
    const pid = "mech-codemode-run-mail-delivery";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      const calls: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
      process.tools.getCodeModeMcpToolBindings = async () => [];
      process.tools.executeCodeModeSyscall = async (
        _context: ProcessTestValue,
        call: string,
        args: Record<string, ProcessTestValue>,
      ) => {
        calls.push({ call, args });
        return { ok: true, deliveryId: args.deliveryId };
      };
      const requestId = "codemode-run-mail-request";
      const response = await instance.recvFrame({
        type: "req",
        id: requestId,
        call: "codemode.run",
        args: {
          code: `return await mail.send({ to: "mike@example.com", text: "Hello" });`,
        },
      });

      const deliveryBase = await stableOpaqueId("mail-send", [
        process.installationId,
        pid,
        requestId,
      ]);
      expect(response).toMatchObject({
        ok: true,
        data: { status: "completed" },
      });
      expect(calls).toEqual([
        {
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: `${deliveryBase}:1`,
          },
        },
      ]);
    });
  });

  it("classifies a failed CodeMode result as a genuine tool failure", async () => {
    const stub = await initProcess("mech-codemode-failed-outcome", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-codemode-failed-outcome";
      const dispatchId = "dispatch-call-codemode-failed";
      process.runs.active = approvedRun(runId);
      process.tools.resumeResolvedToolRun = async () => {};
      registerToolBlock(process, runId, [
        {
          type: "toolCall",
          id: "call-codemode-failed",
          name: "CodeMode",
          arguments: { code: "" },
        },
      ]);
      process.store.tools.markDispatched(dispatchId);

      await process.tools.executeCodeModeTool(
        runId,
        dispatchId,
        { code: "" },
        process.runs.active.approvalPolicy,
      );

      expect(process.store.tools.getResults(runId)).toMatchObject([
        {
          status: "completed",
          result: {
            status: "failed",
            error: "CodeMode requires a non-empty code string",
          },
          outcome: "failed",
        },
      ]);
      await process.tools.ingestToolResults(runId, process.store.tools.getResults(runId));
      const toolResult = process.store.messages.getMessages().at(-1);
      expect(JSON.parse(toolResult.toolCalls)).toMatchObject({
        isError: true,
        outcome: "failed",
      });
    });
  });
});
