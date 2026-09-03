import { describe, expect, it } from "vitest";
import { serverEnvironment } from "./environment";
import { SyntheticKernel } from "./kernel";

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
          processId: "proc:operator",
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
});
