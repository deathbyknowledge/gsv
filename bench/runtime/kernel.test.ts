import { describe, expect, it } from "vitest";
import { serverEnvironment } from "./environment";
import {
  SyntheticKernel,
  type SyntheticProcessRunOutcome,
} from "./kernel";
import type { GsvSemanticLogEntry } from "./schema";

describe("SyntheticKernel", () => {
  it("keeps target ACLs, process capabilities, implementations, and liveness separate", async () => {
    const kernel = new SyntheticKernel({
      now: "2026-09-01T12:00:00.000Z",
      timezone: "Europe/Amsterdam",
    });
    kernel.addProcess({
      id: "ship",
      role: "ship",
      uid: 1000,
      gids: [1000],
      capabilities: ["shell.exec", "sys.device.list"],
    });
    kernel.addProcess({
      id: "worker",
      role: "worker",
      uid: 2000,
      gids: [2000],
      capabilities: ["shell.exec"],
    });
    kernel.addTarget(serverEnvironment({
      id: "server",
      ownerUid: 3000,
      accessGids: [1000],
      online: false,
      implements: ["shell.exec"],
      commands: {
        status: { output: "ready\n" },
      },
    }));
    kernel.afterCall({
      id: "connect-and-share-server",
      after: {
        processId: "ship",
        tool: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      },
      effects: [
        { type: "target.online", targetId: "server", online: true },
        { type: "target.access.grant", targetId: "server", gid: 2000 },
      ],
    });

    expect(kernel.projection("ship").targets).toEqual([]);
    expect(kernel.projection("worker").targets).toEqual([]);

    const discovery = await kernel.dispatch("ship", "Shell", {
      input: "targets list --json",
      target: "gsv",
    });

    expect(discovery.isError).toBe(false);
    expect(discovery.transitionsApplied).toEqual(["connect-and-share-server"]);
    expect(kernel.projection("ship").targets.map(({ id }) => id)).toEqual(["server"]);
    expect(kernel.projection("worker").targets.map(({ id }) => id)).toEqual(["server"]);

    const routed = await kernel.dispatch("worker", "Shell", {
      input: "status",
      target: "server",
    });
    expect(routed.value).toMatchObject({
      status: "completed",
      output: "ready\n",
    });
  });

  it("denies calls outside the Process grant even when a target is visible", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "reader",
        role: "worker",
        uid: 1000,
        gids: [1000],
        capabilities: ["fs.read"],
      }],
    }, {
      targets: [{
        id: "server",
        kind: "server",
        ownerUid: 1000,
        accessGids: [1000],
        online: true,
      }],
      transitions: [],
      events: [],
    });

    expect(kernel.projection("reader").targets.map(({ id }) => id)).toEqual(["server"]);
    const result = await kernel.dispatch("reader", "Shell", {
      input: "status",
      target: "server",
    });
    expect(result).toMatchObject({
      isError: true,
      value: "Permission denied: process cannot call shell.exec",
    });
  });

  it("allows transitions owned by a configured delegate before it is spawned", () => {
    expect(() => SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: [],
      }],
      delegates: [{
        account: "operator",
        process: {
          id: "proc:operator",
          role: "worker",
          uid: 2000,
          gids: [2000],
          capabilities: ["shell.exec"],
        },
        systemPrompt: "Operate the target.",
        maxTurns: 4,
      }],
    }, {
      targets: [{
        id: "server",
        kind: "server",
        ownerUid: 2000,
        accessGids: [2000],
        online: true,
      }],
      transitions: [{
        id: "operator-action",
        after: {
          account: "operator",
          tool: "Shell",
        },
        effects: [{
          type: "target.state.set",
          targetId: "server",
          key: "done",
          value: true,
        }],
      }],
      events: [],
    })).not.toThrow();
  });

  it("keeps native shell discovery and Unix composition available", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec"],
      }],
    }, { targets: [], transitions: [], events: [] });

    const discovery = await kernel.dispatch("ship", "Shell", {
      input: "man --search -- 'list the ordered GSV event log'",
      target: "gsv",
    });
    expect(discovery).toMatchObject({
      isError: false,
      value: {
        status: "completed",
        exitCode: 0,
      },
    });
    expect(JSON.stringify(discovery.value)).toContain(
      "ordered [GSV EVENT] entries are delivered directly",
    );

    const runControlHelp = await kernel.dispatch("ship", "Shell", {
      input: "man process-events; message send --help; yield --help",
      target: "gsv",
    });
    expect(runControlHelp).toMatchObject({
      isError: false,
      value: {
        status: "completed",
        exitCode: 0,
      },
    });
    expect(JSON.stringify(runControlHelp.value)).toContain("PROCESS-EVENTS(7)");
    expect(JSON.stringify(runControlHelp.value)).toContain(
      "message send commits a user-visible message",
    );
    expect(JSON.stringify(runControlHelp.value)).toContain(
      "yield finishes the active run",
    );

    const composed = await kernel.dispatch("ship", "Shell", {
      input: "r12y --help | head -1; echo ready",
      target: "gsv",
    });
    expect(composed).toMatchObject({
      isError: false,
      value: {
        status: "completed",
        output: "Usage:\nready\n",
        exitCode: 0,
      },
    });
  });

  it("persists the native filesystem across shell calls", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec"],
      }],
    }, { targets: [], transitions: [], events: [] });

    const write = await kernel.dispatch("ship", "Shell", {
      input: "mkdir -p /workspace && printf 'durable\\n' > /workspace/note.txt",
      target: "gsv",
    });
    expect(write.isError).toBe(false);

    const read = await kernel.dispatch("ship", "Shell", {
      input: "cat /workspace/note.txt",
      target: "gsv",
    });
    expect(read).toMatchObject({
      isError: false,
      value: {
        status: "completed",
        output: "durable\n",
        exitCode: 0,
      },
    });
  });

  it("shares one native filesystem between direct tools and shell", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["fs.*", "shell.exec"],
      }],
    }, { targets: [], transitions: [], events: [] });

    expect(await kernel.dispatch("ship", "Write", {
      target: "gsv",
      path: "/workspace/state.txt",
      content: "alpha\nbeta\n",
    })).toMatchObject({
      isError: false,
      value: { ok: true, path: "/workspace/state.txt", size: 11 },
    });
    expect(await kernel.dispatch("ship", "Shell", {
      input: "cat /workspace/state.txt",
      target: "gsv",
    })).toMatchObject({
      isError: false,
      value: { output: "alpha\nbeta\n" },
    });

    expect(await kernel.dispatch("ship", "Edit", {
      target: "gsv",
      path: "/workspace/state.txt",
      oldString: "beta",
      newString: "gamma",
    })).toMatchObject({
      isError: false,
      value: { ok: true, replacements: 1 },
    });
    expect(await kernel.dispatch("ship", "Search", {
      target: "gsv",
      path: "/workspace",
      query: "gamma",
      include: "*.txt",
    })).toMatchObject({
      isError: false,
      value: {
        ok: true,
        count: 1,
        matches: [{
          path: "/workspace/state.txt",
          line: 2,
          content: "gamma",
        }],
      },
    });

    await kernel.dispatch("ship", "Shell", {
      input: "printf 'from-shell\\n' > /workspace/shell.txt",
      target: "gsv",
    });
    const directRead = await kernel.dispatch("ship", "Read", {
      target: "gsv",
      path: "/workspace/shell.txt",
    });
    expect(directRead.isError).toBe(false);
    expect(JSON.stringify(directRead.value)).toContain("from-shell");

    expect(await kernel.dispatch("ship", "Delete", {
      target: "gsv",
      path: "/workspace/state.txt",
    })).toMatchObject({ isError: false, value: { ok: true } });
    expect(await kernel.dispatch("ship", "Read", {
      target: "gsv",
      path: "/workspace/state.txt",
    })).toMatchObject({ isError: true });
  });

  it("reports and advances the scenario clock through native date", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "Europe/Amsterdam",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec"],
      }],
    }, {
      targets: [],
      transitions: [],
      events: [{
        id: "one-hour-later",
        processId: "ship",
        delayMs: 60 * 60 * 1_000,
        content: "One logical hour elapsed.",
      }],
    });

    expect(await kernel.dispatch("ship", "Shell", {
      input: "date -u '+%Y-%m-%dT%H:%M:%SZ'",
      target: "gsv",
    })).toMatchObject({
      isError: false,
      value: { output: "2026-09-01T12:00:00Z\n" },
    });

    kernel.advanceAfterYield("ship");
    expect(await kernel.dispatch("ship", "Shell", {
      input: "date -u '+%FT%TZ'",
      target: "gsv",
    })).toMatchObject({
      isError: false,
      value: { output: "2026-09-01T13:00:00Z\n" },
    });
    expect(await kernel.dispatch("ship", "Shell", {
      input: "date '+%Y-%m-%dT%H:%M:%S%:z'",
      target: "gsv",
    })).toMatchObject({
      isError: false,
      value: { output: "2026-09-01T15:00:00+02:00\n" },
    });
    expect(await kernel.dispatch("ship", "Shell", {
      input: "date -u '+%Y-%m-%dT%H:%M:%S.%3NZ'",
      target: "gsv",
    })).toMatchObject({
      isError: false,
      value: { output: "2026-09-01T13:00:00.000Z\n" },
    });
  });

  it("enforces the requested native shell timeout", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec"],
      }],
    }, { targets: [], transitions: [], events: [] });
    const startedAt = Date.now();

    const result = await kernel.dispatch("ship", "Shell", {
      input: [
        "while true; do sleep 5; done &",
        "pid=$!",
        "sleep 15",
        "kill $pid 2>/dev/null",
        "wait $pid 2>/dev/null",
      ].join("; "),
      timeout: 25,
      target: "gsv",
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      isError: true,
      value: {
        status: "failed",
        output: "",
        error: "Command timed out after 25ms",
      },
    });
  });

  it("supports the production-shaped responsibility update command", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec", "r12y.create", "r12y.update"],
      }],
    }, { targets: [], transitions: [], events: [] });

    const created = await kernel.dispatch("ship", "Shell", {
      input: "r12y create --title incident --priority high",
      target: "gsv",
    });
    expect(created.isError).toBe(false);

    const invalidWait = await kernel.dispatch("ship", "Shell", {
      input: "r12y wait r12y:00000000-0000-4000-8000-000000000001",
      target: "gsv",
    });
    expect(invalidWait).toMatchObject({
      isError: true,
      value: {
        error: expect.stringContaining(
          "wait requires --until ISO or --blocker TEXT",
        ),
      },
    });

    const updated = await kernel.dispatch("ship", "Shell", {
      input: "r12y update r12y:00000000-0000-4000-8000-000000000001 --json '{\"priority\":\"low\",\"state\":\"waiting\",\"blocker\":\"superseded\"}'",
      target: "gsv",
    });

    expect(updated).toMatchObject({
      isError: false,
      value: {
        status: "completed",
        exitCode: 0,
      },
    });
    expect(kernel.snapshot().responsibilities.records[
      "r12y:00000000-0000-4000-8000-000000000001"
    ]).toMatchObject({
      priority: "low",
      state: "waiting",
      blocker: "superseded",
    });
  });

  it("resolves scenario responsibilities by semantic identity instead of creation order", async () => {
    const entries: GsvSemanticLogEntry[] = [];
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec", "r12y.create", "r12y.update"],
      }],
    }, {
      responsibilityRefs: [
        { id: "initial", identity: "INC-42" },
        { id: "priority", identity: "INC-43" },
      ],
      targets: [],
      transitions: [],
      events: [{
        id: "priority-arrived",
        processId: "ship",
        delayMs: 1_000,
        content: "INC-43 is now the priority incident.",
        when: {
          responsibilities: {
            references: {
              initial: { state: "waiting" },
            },
          },
        },
      }],
    });
    kernel.setRecorder((entry) => entries.push(entry));

    await kernel.dispatch("ship", "Shell", {
      input: "r12y create --title 'Unrelated housekeeping'",
      target: "gsv",
    });
    await kernel.dispatch("ship", "Shell", {
      input: "r12y create --title 'Coordinate incident INC-42'",
      target: "gsv",
    });
    await kernel.dispatch("ship", "Shell", {
      input: "r12y wait r12y:00000000-0000-4000-8000-000000000002 --blocker 'awaiting priority incident'",
      target: "gsv",
    });

    expect(kernel.advanceAfterYield("ship")).toMatchObject({
      id: "priority-arrived",
      state: "applied",
    });
    expect(kernel.snapshot().responsibilities.references.initial).toMatchObject({
      id: "r12y:00000000-0000-4000-8000-000000000002",
      state: "waiting",
    });
    expect(entries).toContainEqual(expect.objectContaining({
      type: "responsibility.transition",
      responsibilityRefs: ["initial"],
      transition: expect.objectContaining({
        responsibilityId: "r12y:00000000-0000-4000-8000-000000000002",
      }),
    }));
  });

  it("returns a delegation handle before the delegated Process finishes", async () => {
    const entries: GsvSemanticLogEntry[] = [];
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        gids: [1000],
        capabilities: ["shell.exec", "proc.spawn", "proc.ipc.call"],
      }],
      delegates: [{
        account: "researcher",
        process: {
          id: "proc:researcher",
          role: "worker",
          uid: 2000,
          ownerUid: 1000,
          gids: [2000],
          capabilities: [],
        },
        systemPrompt: "Return the delegated result.",
        maxTurns: 1,
      }],
    }, { targets: [], transitions: [], events: [] });
    kernel.setRecorder((entry) => entries.push(entry));

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishWorker!: (outcome: SyntheticProcessRunOutcome) => void;
    const workerOutcome = new Promise<SyntheticProcessRunOutcome>((resolve) => {
      finishWorker = resolve;
    });
    kernel.setDelegateRunner(async () => {
      signalStarted();
      return workerOutcome;
    });

    const dispatch = kernel.dispatch("ship", "Shell", {
      input: "proc delegate --as researcher 'inspect the release'",
      target: "gsv",
    });
    await started;
    const early = await Promise.race([
      dispatch.then((result) => ({ state: "accepted" as const, result })),
      new Promise<{ state: "blocked" }>((resolve) => {
        setImmediate(() => resolve({ state: "blocked" }));
      }),
    ]);
    const whileRunning = kernel.snapshot().delegations[0];

    finishWorker({ status: "returned", resultText: "release is healthy" });
    const result = await dispatch;
    await kernel.settleDelegations();

    expect(early).toMatchObject({
      state: "accepted",
      result: {
        isError: false,
        value: {
          status: "completed",
          output: expect.stringContaining("status=in_progress"),
        },
      },
    });
    expect(result).toMatchObject({
      isError: false,
      value: { status: "completed" },
    });
    expect(whileRunning).toMatchObject({
      targetProcessId: "proc:researcher",
      state: "in_progress",
    });
    expect(kernel.snapshot().delegations[0]).toMatchObject({
      state: "completed",
      resultText: "release is healthy",
    });
    expect(kernel.drainProcessEvents("ship")[0]?.content).toContain(
      "release is healthy",
    );
    expect(entries.at(-1)).toMatchObject({
      type: "ipc.completed",
      targetProcessId: "proc:researcher",
      resultText: "release is healthy",
    });

    const agents = await kernel.dispatch("ship", "Shell", {
      input: "proc agents --json",
      target: "gsv",
    });
    expect(agents).toMatchObject({
      isError: false,
      value: {
        output: expect.stringContaining('"account":"researcher"'),
      },
    });

    kernel.setDelegateRunner(async () => ({
      status: "returned",
      resultText: "second opinion is healthy",
    }));
    const retry = await kernel.dispatch("ship", "Shell", {
      input: "proc delegate --as researcher 'independently recheck the release'",
      target: "gsv",
    });
    await kernel.settleDelegations();

    expect(retry).toMatchObject({
      isError: false,
      value: {
        output: expect.stringContaining("pid=proc:researcher:2"),
      },
    });
    expect(kernel.snapshot().delegations[1]).toMatchObject({
      account: "researcher",
      targetProcessId: "proc:researcher:2",
      state: "completed",
      resultText: "second opinion is healthy",
    });
  });

  it("inherits the source account when delegation omits --as", async () => {
    const kernel = SyntheticKernel.fromSpec({
      runtime: {
        now: "2026-09-01T12:00:00.000Z",
        timezone: "UTC",
      },
      processes: [{
        id: "ship",
        role: "ship",
        uid: 1000,
        username: "personal-agent",
        gids: [1000],
        capabilities: ["shell.exec", "proc.spawn", "proc.ipc.call"],
      }],
    }, { targets: [], transitions: [], events: [] });
    kernel.setDelegateRunner(async (request) => {
      expect(request).toMatchObject({
        processId: "proc:personal-agent",
        maxTurns: 16,
      });
      return { status: "returned", resultText: "done" };
    });

    const result = await kernel.dispatch("ship", "Shell", {
      input: "proc delegate 'handle the bounded task'",
      target: "gsv",
    });
    await kernel.settleDelegations();

    expect(result.isError).toBe(false);
    expect(kernel.snapshot().delegations[0]).toMatchObject({
      account: "personal-agent",
      targetProcessId: "proc:personal-agent",
      state: "completed",
    });
    expect(kernel.snapshot().processes["proc:personal-agent"]).toMatchObject({
      account: "personal-agent",
      uid: 1000,
      role: "worker",
    });
  });
});
