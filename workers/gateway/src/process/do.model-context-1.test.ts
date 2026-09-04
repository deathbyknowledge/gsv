import type { ProcessRuntimeEventDeliverArgs } from "../protocol/process-frames";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  deferred, runInProcess, ROOT_IDENTITY, initProcess, makeRuntimeEventDeliverReq,
  makeRuntimeEventReq, responsibilityKernelResult, terminalTestConfig,
} from "./do-test-harness";

describe("model context", () => {
  it("keeps an empty epoch baseline immutable when work arrives mid-run", async () => {
    const pid = "mech-r12y-mid-run-create";
    const runId = "run-r12y-mid-run-create";
    const responsibilityId = "r12y:00000000-0000-4000-8000-000000000009";
    const requestResponsibilityId = "r12y:00000000-0000-4000-8000-000000000011";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process, _state, instance) => {
      const responsibility = {
        id: responsibilityId,
        ownerUid: 0,
        title: "Review contact message msg:one with the owner",
        details: {
          eventType: "federation.message.received",
          contactId: "contact:flynn",
          contactGeneration: "generation:flynn",
          conversationId: "conv:flynn",
          messageId: "msg:one",
          deliveryId: "delivery:one",
          remoteDisplayName: "Flynn",
          resourceCount: 1,
          contentTrust: "untrusted",
        },
        source: {
          kind: "event",
          eventType: "federation.received",
          eventId: "delivery:one",
        },
        assignee: { kind: "ship" },
        state: "open",
        priority: "high",
        revision: 1,
        createdAtMs: 200,
        updatedAtMs: 200,
      };
      const requestResponsibility = {
        ...responsibility,
        id: requestResponsibilityId,
        title: "Track contact request request:one",
        details: {
          eventType: "federation.request",
          contactId: "contact:flynn",
          contactGeneration: "generation:flynn",
          conversationId: "conv:flynn",
          requestId: "request:one",
          direction: "incoming",
          requestKind: "task",
          requestTitle: "Review the launch plan",
          state: "offered",
          revision: 1,
          remoteDisplayName: "Flynn",
          contentTrust: "untrusted",
          latestDeliveryId: "delivery:request-one",
        },
      };
      process.kernel.kernelRpc = vi.fn(async (call: string, args: any) => {
        if (call === "r12y.list") {
          return { responsibilities: [], count: 0, revision: 0 };
        }
        if (call === "r12y.changes") {
          return args.afterRevision < 1
            ? {
                transitions: [responsibility, requestResponsibility].map((record, index) => ({
                  revision: index + 1,
                  responsibilityId: record.id,
                  kind: "created",
                  afterState: "open",
                  changedFields: ["created"],
                  actor: { kind: "system", component: "federation" },
                  record,
                  createdAtMs: 200 + index,
                })),
                revision: 2,
                hasMore: false,
              }
            : { transitions: [], revision: 2, hasMore: false };
        }
        throw new Error(`unexpected kernel call: ${call}`);
      });
      const run = {
        runId,
        config: {
          ...terminalTestConfig(pid),
          skillIndexMode: "off",
          systemContextFiles: [
            {
              name: "10-responsibilities.md",
              text: "Responsibility baseline:\n{{r12y}}",
            },
          ],
        },
        tools: [],
        targets: [],
        mcpServers: [],
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.runs.active = run;
      const epoch = await process.history.ensureContextEpoch(runId, run, run.config);
      const promptBefore = epoch.systemPrompt;

      const admission = await instance.recvFrame(
        makeRuntimeEventDeliverReq({
          eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000008",
          event: {
            type: "r12y.ready",
            batchId: "batch:00000000-0000-4000-8000-000000000008",
            ledgerRevision: 2,
            responsibilityIds: [responsibilityId, requestResponsibilityId],
          },
        }),
      );
      await process.history.syncResponsibilityDeltas(runId, epoch);

      return {
        admission,
        promptBefore,
        promptAfter: process.store.epochs.getLiveContextEpoch().systemPrompt,
        messages: process.store.messages.getMessages(),
        currentRun: process.runs.active,
      };
    });

    expect(result.admission).toMatchObject({
      type: "res",
      ok: true,
      data: { runId, queued: false },
    });
    expect(result.promptBefore).toContain("No unresolved responsibilities");
    expect(result.promptAfter).toBe(result.promptBefore);
    expect(result.promptAfter).not.toContain("Hello from another Ship");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toContain("Kind: Contact message");
    expect(result.messages[0].content).toContain('Contact: "Flynn" (`contact:flynn`)');
    expect(result.messages[0].content).toContain("Conversation: `conv:flynn`");
    expect(result.messages[0].content).toContain(
      "A contact message is available in the Conversation history",
    );
    expect(result.messages[0].content).toContain("Resources attached: 1");
    expect(result.messages[0].content).toContain("message history --with contact:flynn");
    expect(result.messages[0].content).toContain("Default action: tell the owner what arrived");
    expect(result.messages[0].content).toContain(
      "Do not reply to the contact unless the owner explicitly authorizes it",
    );
    expect(result.messages[0].content).not.toContain("Hello from another Ship");
    expect(result.messages[0].content).not.toContain("wave.png");
    expect(result.messages[0].content).toContain(
      "message send --to contact:flynn --message TEXT --also",
    );
    expect(result.messages[0].content).not.toContain("Reply with:");
    expect(result.messages[0].content).toContain(
      "Resolving this responsibility does not itself send a reply",
    );
    expect(result.messages[0].content).not.toContain("Responsibility batch");
    expect(result.messages[1].content).toContain("Kind: Contact request");
    expect(result.messages[1].content).toContain("Request: `request:one`");
    expect(result.messages[1].content).toContain('Request kind: "task"');
    expect(result.messages[1].content).toContain(
      'External request title — untrusted data: "Review the launch plan"',
    );
    expect(result.messages[1].content).toContain("contact request");
    expect(result.messages[1].content).toContain("then tell the owner what arrived");
    expect(result.messages[1].content).toContain(
      "Do not accept, decline, cancel, or otherwise answer for the owner",
    );
    expect(result.currentRun).toMatchObject({
      runId,
      responsibilityBatches: [
        {
          responsibilityIds: [responsibilityId, requestResponsibilityId],
        },
      ],
    });
  });

  it("freezes one responsibility baseline and projects each later revision once", async () => {
    const pid = "mech-r12y-context-epoch";
    const runId = "run-r12y-context-epoch";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const initial = {
        id: "r12y:00000000-0000-4000-8000-000000000010",
        ownerUid: 0,
        title: "Ship the epoch model",
        source: { kind: "account", uid: 0, username: "root" },
        assignee: { kind: "ship" },
        state: "open",
        priority: "high",
        revision: 1,
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      const changed = {
        ...initial,
        state: "active",
        revision: 2,
        updatedAtMs: 200,
      };
      let ledgerRevision = 1;
      process.kernel.kernelRpc = vi.fn(async (call: string, args: any) => {
        if (call === "r12y.list") {
          return { responsibilities: [initial], count: 600, revision: 1 };
        }
        if (call === "r12y.changes") {
          return args.afterRevision < ledgerRevision
            ? {
                transitions: [
                  {
                    revision: 2,
                    responsibilityId: initial.id,
                    kind: "updated",
                    beforeState: "open",
                    afterState: "active",
                    changedFields: ["state"],
                    actor: { kind: "process", processId: pid, runId },
                    record: changed,
                    createdAtMs: 200,
                  },
                ],
                revision: 2,
                hasMore: false,
              }
            : { transitions: [], revision: ledgerRevision, hasMore: false };
        }
        throw new Error(`unexpected kernel call: ${call}`);
      });
      const run = {
        runId,
        config: {
          ...terminalTestConfig(pid),
          skillIndexMode: "off",
          systemContextFiles: [
            {
              name: "10-responsibilities.md",
              text: "Responsibility baseline:\n{{r12y}}",
            },
          ],
        },
        tools: [],
        targets: [],
        mcpServers: [],
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.runs.active = run;

      const epoch = await process.history.ensureContextEpoch(runId, run, run.config);
      const promptBefore = epoch.systemPrompt;
      ledgerRevision = 2;
      const sameEpoch = await process.history.ensureContextEpoch(runId, run, run.config);
      await process.history.syncResponsibilityDeltas(runId, sameEpoch);
      await process.history.syncResponsibilityDeltas(
        runId,
        process.store.epochs.getLiveContextEpoch(),
      );

      return {
        epoch: process.store.epochs.getLiveContextEpoch(),
        promptBefore,
        promptAfter: run.systemPrompt,
        transitions: process.store.epochs.listContextEpochTransitions(epoch.id),
        deltaMessages: process.store.messages
          .getMessages()
          .filter(
            (message: any) =>
              message.role === "system" && message.content.includes("ledger revision 2"),
          ),
        calls: process.kernel.kernelRpc.mock.calls,
      };
    });

    expect(result.promptBefore).toContain("Ship the epoch model");
    expect(result.promptBefore).toContain("599 additional unresolved responsibilities");
    expect(result.promptAfter).toBe(result.promptBefore);
    expect(result.epoch).toMatchObject({
      r12yRevision: 1,
      r12yCount: 600,
      observedR12yRevision: 2,
      state: "live",
    });
    expect(result.transitions).toHaveLength(1);
    expect(result.deltaMessages).toHaveLength(1);
    expect(result.calls.filter(([call]: [string]) => call === "r12y.list")).toHaveLength(1);
  });

  it("appends availability deltas without rotating the frozen epoch", async () => {
    const pid = "mech-context-projection-delta";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        const responsibilityResult = responsibilityKernelResult(call);
        if (responsibilityResult) return responsibilityResult;
        throw new Error(`unexpected kernel call: ${call}`);
      });
      const config = {
        ...terminalTestConfig(pid),
        systemContextFiles: [
          {
            name: "00-runtime.md",
            text: "Date: {{current.date}}\nTargets:\n{{devices}}\nMCP:\n{{mcpServers}}",
          },
        ],
        skillIndexMode: "summary" as const,
        skillIndex: [
          {
            id: "alpha",
            name: "Alpha",
            description: "Alpha workflow",
            source: { kind: "home" as const, label: "home", writable: true },
          },
        ],
      };
      const firstSnapshot = {
        targets: [
          {
            id: "laptop",
            label: "Laptop",
            platform: "linux",
            implements: ["shell.exec"],
          },
        ],
        mcpServers: ["Search"],
        systemContextFiles: config.systemContextFiles,
        system: { timezone: "UTC" },
        skillIndex: config.skillIndex,
        skillIndexMode: config.skillIndexMode,
      };
      const firstProjection = {
        version: 1 as const,
        runtime: { date: "2026-08-28", timezone: "UTC" },
        targets: [
          {
            id: "laptop",
            implements: ["shell.exec"],
            label: "Laptop",
            platform: "linux",
          },
        ],
        mcpServers: firstSnapshot.mcpServers,
        skills: {
          mode: config.skillIndexMode,
          entries: [{ id: "alpha", description: "Alpha workflow" }],
        },
      };
      const firstRun = {
        runId: "run-projection-a",
        config,
        tools: [],
        devices: firstSnapshot.targets,
        mcpServers: firstSnapshot.mcpServers,
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.runs.active = firstRun;
      const firstEpoch = await process.history.ensureContextEpoch(
        firstRun.runId,
        firstRun,
        config,
        firstSnapshot,
        firstProjection,
      );

      const nextSnapshot = {
        ...firstSnapshot,
        targets: [
          {
            id: "desktop",
            label: "Desktop",
            platform: "linux",
            implements: ["fs.read", "shell.exec"],
          },
        ],
        mcpServers: ["Calendar"],
        skillIndex: [
          {
            id: "beta",
            name: "Beta",
            description: "Beta workflow",
            source: { kind: "home" as const, label: "home", writable: true },
          },
        ],
      };
      const nextProjection = {
        version: 1 as const,
        runtime: { date: "2026-08-29", timezone: "UTC" },
        targets: [
          {
            id: "desktop",
            implements: ["fs.read", "shell.exec"],
            label: "Desktop",
            platform: "linux",
          },
        ],
        mcpServers: nextSnapshot.mcpServers,
        skills: {
          mode: config.skillIndexMode,
          entries: [{ id: "beta", description: "Beta workflow" }],
        },
      };
      const nextRun = {
        ...firstRun,
        runId: "run-projection-b",
        systemPrompt: undefined,
        contextEpochId: undefined,
        devices: nextSnapshot.targets,
        mcpServers: nextSnapshot.mcpServers,
      };
      process.runs.active = nextRun;
      const sameEpoch = await process.history.ensureContextEpoch(
        nextRun.runId,
        nextRun,
        config,
        nextSnapshot,
        nextProjection,
      );
      await process.history.syncContextProjection(nextRun.runId, sameEpoch, nextProjection);

      return {
        firstEpoch,
        liveEpoch: process.store.epochs.getLiveContextEpoch(),
        epochs: process.store.epochs.listContextEpochs(),
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.liveEpoch.id).toBe(result.firstEpoch.id);
    expect(result.epochs).toHaveLength(1);
    expect(result.liveEpoch.systemPrompt).toContain("Date: 2026-08-28");
    expect(result.liveEpoch.systemPrompt).toContain("laptop: Laptop (linux)");
    expect(result.liveEpoch.systemPrompt).toContain("- Search");
    expect(result.liveEpoch.systemPrompt).toContain("<name>alpha</name>");
    expect(result.liveEpoch.systemPrompt).not.toContain("desktop");
    expect(result.liveEpoch.observedProjection).toMatchObject({
      runtime: { date: "2026-08-29" },
      targets: [{ id: "desktop" }],
      mcpServers: ["Calendar"],
      skills: { entries: [{ id: "beta" }] },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain("Context availability changed.");
    expect(result.messages[0].content).toContain("- Added: `desktop`");
    expect(result.messages[0].content).toContain("- Removed: `laptop`");
    expect(result.messages[0].content).toContain("Current date: 2026-08-29");
  });

  it("archives and replaces a legacy epoch before installing projection state", async () => {
    const pid = "mech-context-projection-upgrade";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        const responsibilityResult = responsibilityKernelResult(call);
        if (responsibilityResult) return responsibilityResult;
        throw new Error(`unexpected kernel call: ${call}`);
      });
      const legacyProjection = {
        version: 1,
        runtime: { date: "2026-08-28", timezone: "UTC" },
        targets: [],
        mcpServers: [],
        skills: { mode: "off", entries: [] },
      };
      const legacy = process.store.epochs.createContextEpoch({
        id: "epoch-legacy",
        generation: 1,
        systemPrompt: "legacy prompt",
        r12yRevision: 0,
        r12yCount: 0,
        r12yBaseline: [],
        sourceManifest: { version: 1 },
        observedProjection: legacyProjection,
        now: 100,
      });
      process.store.messages.appendMessage("user", "Old epoch activity", {
        runId: "run-legacy",
      });
      const config = {
        ...terminalTestConfig(pid),
        skillIndexMode: "off" as const,
        systemContextFiles: [{ name: "00-test.md", text: "current prompt" }],
      };
      const snapshot = {
        targets: [],
        mcpServers: [],
        systemContextFiles: config.systemContextFiles,
        system: { timezone: "UTC" },
        skillIndex: [],
        skillIndexMode: "off" as const,
      };
      const run = {
        runId: "run-current",
        config,
        tools: [],
        targets: [],
        mcpServers: [],
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.store.messages.appendMessage("user", "New epoch activity", { runId: run.runId });
      process.runs.active = run;
      const replacement = await process.history.ensureContextEpoch(
        run.runId,
        run,
        config,
        snapshot,
        legacyProjection,
      );
      return {
        legacy,
        replacement,
        epochs: process.store.epochs.listContextEpochs(),
      };
    });

    expect(result.replacement.id).not.toBe(result.legacy.id);
    expect(result.replacement.sourceManifest).toMatchObject({
      version: 2,
      contextProjection: { version: 1 },
    });
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[0]).toMatchObject({
      id: "epoch-legacy",
      state: "closed",
      closeReason: "context.changed",
      archivePath: expect.stringContaining("/epochs/epoch-legacy.json.gz"),
    });
  });

  it("closes and archives the exact epoch when standing context changes", async () => {
    const pid = "mech-context-epoch-rotation";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        const responsibilityResult = responsibilityKernelResult(call);
        if (responsibilityResult) return responsibilityResult;
        throw new Error(`unexpected kernel call: ${call}`);
      });
      process.store.messages.appendMessage("user", "Preserve this exact activity.", {
        runId: "run-epoch-a",
      });
      const configA = {
        ...terminalTestConfig(pid),
        skillIndexMode: "off",
        systemContextFiles: [{ name: "00-test.md", text: "epoch alpha" }],
      };
      const runA = {
        runId: "run-epoch-a",
        config: configA,
        tools: [],
        targets: [],
        mcpServers: [],
        approvalPolicy: { default: "auto", rules: [] },
      };
      process.runs.active = runA;
      const epochA = await process.history.ensureContextEpoch(runA.runId, runA, configA);
      process.store.epochs.recordContextEpochRun(
        runA.runId,
        {
          runId: runA.runId,
          status: "ok",
          delivery: {
            kind: "message",
            conversationId: "conv:ship",
            messageId: "msg:epoch-a",
          },
        },
        200,
      );

      const configB = {
        ...configA,
        systemContextFiles: [{ name: "00-test.md", text: "epoch beta" }],
      };
      const runB = {
        ...runA,
        runId: "run-epoch-b",
        config: configB,
        systemPrompt: undefined,
      };
      process.store.messages.appendMessage("user", "This belongs to epoch beta.", {
        runId: runB.runId,
      });
      process.runs.active = runB;
      const epochB = await process.history.ensureContextEpoch(runB.runId, runB, configB);
      const epochs = process.store.epochs.listContextEpochs();
      const closed = epochs.find((epoch: any) => epoch.id === epochA.id);
      if (!closed?.archivePath) throw new Error("Expected closed epoch archive");
      const archived = await process.storage.get(closed.archivePath.replace(/^\/+/, ""));
      if (!archived) throw new Error("Expected stored epoch archive");
      const manifest = await new Response(
        archived.body.pipeThrough(new DecompressionStream("gzip")),
      ).json();
      return { epochA, epochB, epochs, manifest };
    });

    expect(result.epochA.systemPrompt).toContain("epoch alpha");
    expect(result.epochB.systemPrompt).toContain("epoch beta");
    expect(result.epochB.id).not.toBe(result.epochA.id);
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[0]).toMatchObject({
      id: result.epochA.id,
      state: "closed",
      closeReason: "context.changed",
      archivePath: expect.stringContaining("/epochs/"),
    });
    expect(result.epochs[1]).toMatchObject({
      id: result.epochB.id,
      state: "live",
    });
    expect(result.manifest).toMatchObject({
      epoch: {
        id: result.epochA.id,
        systemPrompt: expect.stringContaining("epoch alpha"),
        processActivity: [
          expect.objectContaining({
            content: "Preserve this exact activity.",
          }),
        ],
        runBoundaries: [
          expect.objectContaining({
            runId: "run-epoch-a",
            delivery: {
              kind: "message",
              conversationId: "conv:ship",
              messageId: "msg:epoch-a",
            },
          }),
        ],
      },
    });
    expect(result.manifest.epoch.processActivity).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "This belongs to epoch beta." }),
      ]),
    );
  });

  it("admits a typed work-return event exactly once", async () => {
    const stub = await initProcess("mech-work-return-event", ROOT_IDENTITY);
    const firstRequest = makeRuntimeEventReq("adapter-home:event-1", "proc:work-1");
    const first = await stub.recvFrame(firstRequest);
    await evictDurableObject(stub);
    const replayRequest = makeRuntimeEventReq("adapter-home:event-1", "proc:work-1");
    const replay = await stub.recvFrame(replayRequest);

    expect(first).toMatchObject({
      type: "res",
      id: firstRequest.id,
      ok: true,
      data: { runId: "adapter-home:event-1", queued: false },
    });
    expect(replay).toMatchObject({
      type: "res",
      id: replayRequest.id,
      ok: true,
      data: { runId: "adapter-home:event-1", queued: false },
    });

    const messages = await runInProcess(stub, (process) =>
      process.store.messages.getMessages(),
    );
    const admitted = messages.filter(
      (message: any) =>
        message.runId === "adapter-home:event-1" &&
        message.content.includes("returned from work process"),
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      role: "system",
      runId: "adapter-home:event-1",
    });
    expect(admitted[0].content).toContain("returned from work process `proc:work-1`");
    expect(admitted[0].content).toContain("No work-session transcript was attached");
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("includes process system messages as model-visible events", async () => {
    const pid = "mech-system-context-1";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage(
        "system",
        "Delegated task finished with result GREEN.",
      );
      process.store.messages.appendMessage("user", "What was the result?");

      const messages = await process.history.buildContextMessages("default");
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: "user" });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((messages[0] as any).content).toContain("[GSV EVENT]");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((messages[0] as any).content).toContain(
        "Delegated task finished with result GREEN.",
      );
      expect(messages[1]).toMatchObject({
        role: "user",
        content: "What was the result?",
      });
    });
  });

  it("keeps process events after matching tool results in provider context", async () => {
    const pid = "mech-system-context-tool-order";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage("assistant", "Let me check that.", {
        toolCalls: JSON.stringify({
          toolCalls: [
            {
              type: "toolCall",
              id: "call_shell",
              name: "Shell",
              arguments: { input: "sleep 10 && date", target: "gsv" },
            },
          ],
        }),
      });
      process.store.messages.appendMessage(
        "system",
        "Delegated task from process `worker` finished.",
      );
      process.store.messages.appendToolResult(
        "call_shell",
        "shell.exec",
        JSON.stringify({ ok: true, stdout: "done" }),
        false,
      );

      const messages = await process.history.buildContextMessages("default");
      expect(messages.map((message: any) => message.role)).toEqual([
        "assistant",
        "toolResult",
        "user",
      ]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((messages[1] as any).toolCallId).toBe("call_shell");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((messages[2] as any).content).toContain("[GSV EVENT]");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((messages[2] as any).content).toContain(
        "Delegated task from process `worker` finished",
      );
    });
  });

  it("does not drop tool results after 200 stored messages", async () => {
    const pid = "mech-context-tool-result-after-200";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      for (let i = 1; i <= 199; i += 1) {
        process.store.messages.appendMessage("user", `filler-${i}`);
      }
      process.store.messages.appendMessage("assistant", "", {
        toolCalls: JSON.stringify({
          toolCalls: [
            {
              type: "toolCall",
              id: "call-boundary|fc_boundary",
              name: "Search",
              arguments: { query: "thinking-status" },
            },
          ],
        }),
      });
      process.store.messages.appendToolResult(
        "call-boundary|fc_boundary",
        "fs.search",
        JSON.stringify({ ok: true, count: 0, matches: [] }),
        false,
      );

      const messages = await process.history.buildContextMessages("default");
      expect(messages).toHaveLength(201);
      expect(messages[199]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-boundary|fc_boundary",
            name: "Search",
          },
        ],
      });
      expect(messages[200]).toMatchObject({
        role: "toolResult",
        toolCallId: "call-boundary|fc_boundary",
        toolName: "Search",
      });
    });
  });

  it("admits a responsibility batch into the active run exactly once", async () => {
    const stub = await initProcess("mech-r12y-event-active", ROOT_IDENTITY);
    const args: ProcessRuntimeEventDeliverArgs = {
      eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000001",
      event: {
        type: "r12y.ready",
        batchId: "batch:00000000-0000-4000-8000-000000000001",
        ledgerRevision: 7,
        responsibilityIds: ["r12y:00000000-0000-4000-8000-000000000002"],
      },
    };

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = { runId: "run-busy" };

      const first = await instance.recvFrame(makeRuntimeEventDeliverReq(args));
      const repeat = await instance.recvFrame(makeRuntimeEventDeliverReq(args));

      expect(first).toMatchObject({
        type: "res",
        ok: true,
        data: {
          eventId: args.eventId,
          runId: "run-busy",
          queued: false,
        },
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((repeat as any).data).toEqual((first as any).data);
      expect(process.store.messages.getMessages()).toHaveLength(0);
      expect(process.runs.active).toMatchObject({
        runId: "run-busy",
        pendingRuntimeEvents: 1,
        responsibilityBatches: [
          {
            batchId: args.event.batchId,
            responsibilityIds: [args.event.responsibilityIds[0]],
          },
        ],
      });
    });
  });

  it("preserves same-run runtime state across input-loading awaits", async () => {
    const pid = "mech-r12y-input-loading-race";
    const runId = "run-r12y-input-loading-race";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const first = {
      eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000031",
      event: {
        type: "r12y.ready" as const,
        batchId: "batch:00000000-0000-4000-8000-000000000031",
        ledgerRevision: 1,
        responsibilityIds: ["r12y:00000000-0000-4000-8000-000000000032"],
      },
    };
    const second = {
      eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000033",
      event: {
        type: "r12y.ready" as const,
        batchId: "batch:00000000-0000-4000-8000-000000000033",
        ledgerRevision: 2,
        responsibilityIds: ["r12y:00000000-0000-4000-8000-000000000034"],
      },
    };

    await runInProcess(stub, async (process, _state, instance) => {
      const { promise: configBlocked, resolve: releaseConfig } = deferred();
      const { promise: configStarted, resolve: markConfigStarted } = deferred();
      const { promise: toolsBlocked, resolve: releaseTools } = deferred();
      const { promise: toolsStarted, resolve: markToolsStarted } = deferred();
      const { promise: contextBlocked, resolve: releaseContext } = deferred();
      const { promise: contextStarted, resolve: markContextStarted } = deferred();
      process.settings.resolveAiConfig = vi.fn(async () => {
        markConfigStarted();
        await configBlocked;
        return terminalTestConfig(pid);
      });
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        if (call === "ai.tools") {
          markToolsStarted();
          await toolsBlocked;
          return { tools: [], devices: [], mcpServers: [] };
        }
        return responsibilityKernelResult(call);
      });
      process.settings.resolveAiContext = vi.fn(async () => {
        markContextStarted();
        await contextBlocked;
        return {
          targets: [],
          mcpServers: [],
          system: { timezone: "UTC" },
          skillIndex: [],
          skillIndexMode: "summary",
        };
      });
      process.run.scheduleTick = vi.fn(async () => {});
      process.sendSignal = vi.fn(async () => {});
      process.store.messages.appendMessage("user", "Keep both responsibility batches.", {
        runId,
      });
      process.runs.active = { runId };

      const ticking = process.run.runTick(runId);
      await configStarted;
      await instance.recvFrame(makeRuntimeEventDeliverReq(first));
      releaseConfig();
      await toolsStarted;
      await instance.recvFrame(makeRuntimeEventDeliverReq(second));
      releaseTools();
      await contextStarted;

      expect(process.runs.active).toMatchObject({
        runId,
        pendingRuntimeEvents: 2,
        responsibilityBatches: [
          {
            batchId: first.event.batchId,
            responsibilityIds: first.event.responsibilityIds,
          },
          {
            batchId: second.event.batchId,
            responsibilityIds: second.event.responsibilityIds,
          },
        ],
      });

      process.runs.active = null;
      releaseContext();
      await ticking;
    });
  });

  it("prevents a responsibility-triggered run from yielding unhandled work", async () => {
    const pid = "mech-r12y-yield-boundary";
    const runId = "run-r12y-yield-boundary";
    const responsibilityId = "r12y:00000000-0000-4000-8000-000000000020";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const responsibility = {
        id: responsibilityId,
        ownerUid: 0,
        title: "Repair the adapter",
        source: { kind: "system", component: "adapter" },
        assignee: { kind: "ship" },
        state: "open",
        priority: "high",
        revision: 1,
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      process.runs.active = {
        runId,
        responsibilityBatches: [
          {
            batchId: "batch:00000000-0000-4000-8000-000000000021",
            responsibilityIds: [responsibilityId],
          },
        ],
      };
      process.kernel.kernelRpc = vi.fn(async () => ({
        responsibilities: [responsibility],
        count: 1,
        revision: responsibility.revision,
      }));
      process.streams.emitProjection = vi.fn(async () => {});
      process.streams.complete = vi.fn(async () => {});

      const blockedYield = await process.run.executeRunControlAction(
        runId,
        "yield-action",
        { ok: true, command: { action: "yield" } },
        [],
      );
      const blockedMessage = await process.run.executeRunControlAction(
        runId,
        "message-action",
        {
          ok: true,
          command: { action: "message", text: "I handled it.", finish: true },
        },
        [],
      );

      expect(blockedYield).toMatchObject({
        ok: false,
        failureKind: "command",
        error: expect.stringContaining(responsibilityId),
      });
      expect(blockedMessage).toMatchObject({
        ok: false,
        failureKind: "command",
        error: expect.stringContaining(responsibilityId),
      });
      expect(process.streams.emitProjection).not.toHaveBeenCalled();
      expect(process.streams.complete).not.toHaveBeenCalled();

      process.kernel.kernelRpc.mockResolvedValue({
        responsibilities: [
          {
            ...responsibility,
            assignee: { kind: "process", processId: "proc:repair-child" },
            state: "active",
            leaseExpiresAtMs: Date.now() + 60_000,
            revision: 2,
            updatedAtMs: 200,
          },
        ],
        count: 1,
        revision: 2,
      });
      const delegatedYield = await process.run.executeRunControlAction(
        runId,
        "delegated-yield-action",
        { ok: true, command: { action: "yield" } },
        [],
      );

      expect(delegatedYield).toMatchObject({
        ok: true,
        action: "yield",
        finish: true,
      });
      expect(process.streams.emitProjection).toHaveBeenCalledOnce();

      process.kernel.kernelRpc.mockResolvedValue({
        responsibilities: [
          {
            ...responsibility,
            assignee: { kind: "process", processId: "proc:repair-child" },
            state: "waiting",
            blocker: "Worker stopped responding",
            leaseExpiresAtMs: Date.now() - 1,
            revision: 3,
            updatedAtMs: 300,
          },
        ],
        count: 1,
        revision: 3,
      });
      const expiredDelegation = await process.run.executeRunControlAction(
        runId,
        "expired-delegation-yield",
        { ok: true, command: { action: "yield" } },
        [],
      );
      expect(expiredDelegation).toMatchObject({
        ok: false,
        failureKind: "command",
        error: expect.stringContaining(responsibilityId),
      });
    });
  });
});
