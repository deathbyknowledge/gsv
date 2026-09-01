import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import type {
  AssistantMessage,
  Context,
  ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatContextProjectionEvent } from "../../workers/gateway/src/prompts/context-events";
import { SyntheticKernel } from "./kernel";
import { parseGsvSurfaceScenario } from "./scenario";
import {
  runGsvSurfaceScenario,
  runSyntheticProcess,
} from "./surface";

const FIXTURES = resolve(
  import.meta.dirname,
  "../verifiers/gsv_v1/gsv_v1/fixtures",
);

describe("GSV Process surface", () => {
  it("freezes the epoch prompt and appends a production context event", async () => {
    const scenario = await fixture("target-appears-after-inspection.json");
    const scripted = [
      assistant(toolCall("inspect-targets", "Shell", {
        input: "targets list --json",
        target: "gsv",
      })),
      assistant(toolCall("finish", "Shell", {
        input: "message send --message 'gpu-lab ready' && yield",
      })),
    ];
    const seen: Context[] = [];

    const artifact = await runGsvSurfaceScenario(scenario, async (context) => {
      seen.push(context);
      const next = scripted.shift();
      if (!next) throw new Error("Unexpected model turn");
      return next;
    });

    expect(artifact.status).toBe("yielded");
    expect(artifact.committedMessages).toEqual(["gpu-lab ready"]);
    expect(artifact.world.transitionsApplied).toEqual(["connect-gpu-lab"]);
    expect(artifact.log.map(({ type }) => type)).toEqual([
      "run.started",
      "tool.call",
      "tool.result",
      "world.transition",
      "context.delta",
      "tool.call",
      "message.committed",
      "tool.result",
      "run.yielded",
    ]);
    expect(new Set(
      artifact.observations.map(({ systemPromptSha256 }) => systemPromptSha256),
    ).size).toBe(1);
    expect(artifact.observations[0]?.projection.targets).toEqual([]);
    expect(artifact.observations[1]?.projection.targets.map(({ id }) => id))
      .toEqual(["gpu-lab"]);
    const delta = artifact.log.find(({ type }) => type === "context.delta");
    expect(delta).toEqual({
      type: "context.delta",
      processId: "ship",
      content: "[GSV EVENT]\n" + formatContextProjectionEvent(
        artifact.observations[0]!.projection,
        artifact.observations[1]!.projection,
      ),
    });
    expect(seen[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: delta?.type === "context.delta" ? delta.content : undefined,
    });
  });

  it("preserves one Process epoch across a logical-time wake and eviction", async () => {
    const scenario = parseGsvSurfaceScenario({
      schemaVersion: 2,
      id: "multi-run-wake",
      description: "Resume one Process after an external state change.",
      systemPrompt: "Observe durable GSV events across runs.",
      prompt: "Wait for the monitor update, then report ready.",
      entryProcessId: "ship",
      world: {
        runtime: {
          now: "2026-09-01T12:00:00.000Z",
          timezone: "Europe/Amsterdam",
        },
        processes: [{
          id: "ship",
          role: "ship",
          uid: 1000,
          gids: [1000],
          capabilities: ["shell.exec", "fs.read"],
        }],
        targets: [{
          id: "monitor",
          kind: "server",
          ownerUid: 1000,
          accessGids: [1000],
          online: true,
          implements: ["fs.read"],
          files: { "/status": "pending\n" },
        }],
      },
      transitions: [],
      externalEvents: [{
        id: "monitor-ready",
        processId: "ship",
        delayMs: 300_000,
        content: "The monitor completed its next observation window.",
        effects: [{
          type: "target.file.write",
          targetId: "monitor",
          path: "/status",
          content: "ready\n",
        }],
        evictProcess: true,
      }],
      expected: {},
      rubric: [{
        id: "complete",
        description: "The resumed Process reports completion.",
        weight: 1,
        expected: {},
      }],
      maxTurns: 2,
      maxRuns: 2,
    });
    const scripted = [
      assistant(toolCall("wait", "Shell", { input: "yield" })),
      assistant(toolCall("finish", "Shell", {
        input: "message send --message 'ready' && yield",
      })),
    ];

    const artifact = await runGsvSurfaceScenario(scenario, async () => {
      const next = scripted.shift();
      if (!next) throw new Error("Unexpected model turn");
      return next;
    });

    expect(artifact.status).toBe("yielded");
    expect(artifact.runs.filter(({ processId }) => processId === "ship"))
      .toEqual([
        { run: 1, processId: "ship", status: "yielded" },
        { run: 2, processId: "ship", status: "yielded" },
      ]);
    expect(artifact.world.runtime.now).toBe("2026-09-01T12:05:00.000Z");
    expect(artifact.world.targets.monitor?.files["/status"]).toBe("ready\n");
    expect(artifact.world.externalEvents).toEqual([{
      id: "monitor-ready",
      processId: "ship",
      state: "applied",
      appliedAtMs: Date.parse("2026-09-01T12:05:00.000Z"),
    }]);
    expect(artifact.log.map(({ type }) => type)).toContain("process.evicted");
    const shipObservations = artifact.observations.filter(
      ({ processId }) => processId === "ship",
    );
    expect(shipObservations.map(({ run }) => run)).toEqual([1, 2]);
    expect(new Set(shipObservations.map(({ systemPromptSha256 }) => (
      systemPromptSha256
    ))).size).toBe(1);
    expect(JSON.stringify(shipObservations[1]?.messages)).toContain(
      "The monitor completed its next observation window.",
    );
    expect(JSON.stringify(shipObservations[1]?.messages)).toContain("Run yielded");
  });

  it("routes one Process across laptop and server environments", async () => {
    const scenario = await fixture("deploy-release-across-targets.json");
    const scripted = [
      assistant(toolCall("read-release", "Read", {
        path: "/workspace/release.txt",
        target: "build-laptop",
      })),
      assistant(toolCall("deploy-release", "Shell", {
        input: "deploy release-2026.09.01",
        target: "deploy-server",
      })),
      assistant(toolCall("finish", "Shell", {
        input: "message send --message 'release deployed' && yield",
      })),
    ];

    const artifact = await runGsvSurfaceScenario(scenario, async () => {
      const next = scripted.shift();
      if (!next) throw new Error("Unexpected model turn");
      return next;
    });

    expect(artifact.status).toBe("yielded");
    expect(artifact.world.targets["deploy-server"]?.state).toMatchObject({
      deployedRelease: "release-2026.09.01",
    });
    expect(artifact.world.processes.ship?.visibleTargets).toEqual([
      "build-laptop",
      "deploy-server",
    ]);
    expect(artifact.world.processes["deploy-worker"]?.visibleTargets).toEqual([
      "deploy-server",
    ]);
    expect(artifact.observations[0]?.tools.map(({ name }) => name))
      .toEqual(["Read", "Shell"]);
  });

  it("lets a bounded worker return ordinary assistant output", async () => {
    const scenario = await fixture("deploy-release-across-targets.json");
    const kernel = SyntheticKernel.fromSpec(scenario.world);

    const artifact = await runSyntheticProcess(
      kernel,
      "deploy-worker",
      "worker-return",
      scenario.systemPrompt,
      "Report the current deployment state.",
      2,
      async () => textAssistant("No deployment is active."),
    );

    expect(artifact.status).toBe("returned");
    expect(artifact.resultText).toBe("No deployment is active.");
    expect(artifact.committedMessages).toEqual([]);
    expect(artifact.log.at(-1)).toEqual({
      type: "run.returned",
      processId: "deploy-worker",
      text: "No deployment is active.",
    });
  });

  it("supervises delegated r12y work and replies through the exact Slack route", async () => {
    const scenario = await fixture("delegate-incident-from-slack.json");
    const shipResponses = [
      assistant(toolCall("create-responsibility", "Shell", {
        input: "r12y create --title 'Investigate checkout deployment' --dedupe 'slack:incident-42'",
        target: "gsv",
      })),
      assistant(toolCall("delegate", "Shell", {
        input: "proc delegate --as ops --responsibility r12y:00000000-0000-4000-8000-000000000001 'Read /var/log/deploy.log on target incident-server and return exactly the value after ROOT_CAUSE=.'",
        target: "gsv",
      })),
      assistant(toolCall("resolve", "Shell", {
        input: "r12y resolve r12y:00000000-0000-4000-8000-000000000001 --json '{\"cause\":\"database migration checksum mismatch\"}'",
        target: "gsv",
      })),
      assistant(toolCall("reply", "Shell", {
        input: "message send --message 'checkout blocked: database migration checksum mismatch' && yield",
      })),
    ];
    const workerResponses = [
      assistant(toolCall("read-log", "Read", {
        path: "/var/log/deploy.log",
        target: "incident-server",
      })),
      textAssistant("database migration checksum mismatch"),
    ];

    const artifact = await runGsvSurfaceScenario(scenario, async (context) => {
      const delegated = String(context.messages[0]?.content)
        .includes("Delegated task from ship (ship).");
      const next = delegated ? workerResponses.shift() : shipResponses.shift();
      if (!next) throw new Error("Unexpected model turn");
      return next;
    });

    expect(artifact.status).toBe("yielded");
    expect(artifact.committedMessages).toEqual([
      "checkout blocked: database migration checksum mismatch",
    ]);
    expect(artifact.world.processes.ship).toMatchObject({
      visibleTargets: [],
      state: "idle",
    });
    expect(artifact.world.processes["proc:incident-worker"]).toMatchObject({
      parentProcessId: "ship",
      visibleTargets: ["incident-server"],
      state: "returned",
    });
    expect(artifact.world.delegations).toEqual([
      expect.objectContaining({
        sourceProcessId: "ship",
        targetProcessId: "proc:incident-worker",
        state: "completed",
        resultText: "database migration checksum mismatch",
        normalizedResultText: "database migration checksum mismatch",
      }),
    ]);
    expect(artifact.world.responsibilities).toMatchObject({
      revision: 4,
      records: {
        "r12y:00000000-0000-4000-8000-000000000001": {
          state: "resolved",
          assignee: { kind: "ship" },
          resolution: { cause: "database migration checksum mismatch" },
        },
      },
    });
    expect(artifact.world.adapters.slack?.deliveries).toEqual([{
      deliveryId: "slack:event:incident-42:reply:1",
      processId: "ship",
      surface: { kind: "dm", id: "D-incident-42" },
      text: "checkout blocked: database migration checksum mismatch",
      replyToId: "slack-message-42",
      state: "sent",
    }]);
    expect(artifact.observations
      .filter(({ processId }) => processId === "proc:incident-worker")[0]
      ?.tools.map(({ name }) => name)).toEqual(["Read"]);
    expect(artifact.observations
      .filter(({ processId }) => processId === "proc:incident-worker")[0]
      ?.messages[0]?.content).toContain("Delegated task from ship (ship).");
    expect(artifact.observations
      .filter(({ processId }) => processId === "ship")
      .some(({ messages }) => JSON.stringify(messages).includes(
        "Delegated task from process `proc:incident-worker` finished.",
      ))).toBe(true);
    for (const processId of ["ship", "proc:incident-worker"]) {
      expect(new Set(artifact.observations
        .filter((observation) => observation.processId === processId)
        .map(({ systemPromptSha256 }) => systemPromptSha256)).size).toBe(1);
    }
  });
});

async function fixture(name: string) {
  return parseGsvSurfaceScenario(
    JSON.parse(await readFile(resolve(FIXTURES, name), "utf8")),
  );
}

function toolCall(
  id: string,
  name: string,
  arguments_: JsonObject,
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: arguments_,
  };
}

function assistant(call: ToolCall): AssistantMessage {
  return assistantMessage([call], "toolUse");
}

function textAssistant(text: string): AssistantMessage {
  return assistantMessage([{ type: "text", text }], "stop");
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "custom",
    model: "gsv-bench-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}
