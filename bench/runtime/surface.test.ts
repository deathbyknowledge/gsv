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
