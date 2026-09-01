import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatContextProjectionEvent } from "../../workers/gateway/src/prompts/context-events";
import { parseGsvSurfaceScenario } from "./scenario";
import { runGsvSurfaceScenario } from "./surface";

const FIXTURE = fileURLToPath(new URL(
  "../verifiers/gsv_v1/gsv_v1/fixtures/target-appears-after-inspection.json",
  import.meta.url,
));

describe("GSV Process surface", () => {
  it("keeps the epoch prompt fixed, appends the context delta, and scores the exact action log", async () => {
    const scenario = parseGsvSurfaceScenario(JSON.parse(await readFile(FIXTURE, "utf8")));
    const scripted = [
      assistant(toolCall("inspect-targets", "targets list")),
      assistant(toolCall(
        "finish",
        "message send --message 'gpu-lab ready' && yield",
      )),
    ];
    const seen: Context[] = [];

    const artifact = await runGsvSurfaceScenario(scenario, async (context) => {
      seen.push(context);
      const next = scripted.shift();
      if (!next) throw new Error("Unexpected model turn");
      return next;
    });

    expect(artifact.status).toBe("yielded");
    expect(artifact.log).toEqual(scenario.expectedLog);
    expect(artifact.committedMessages).toEqual(["gpu-lab ready"]);
    expect(new Set(
      artifact.observations.map(({ systemPromptSha256 }) => systemPromptSha256),
    ).size).toBe(1);
    expect(seen).toHaveLength(2);
    const contextDelta = scenario.expectedLog.find(
      (entry) => entry.type === "context.delta",
    );
    expect(contextDelta).toBeDefined();
    expect(seen[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: contextDelta?.content,
    });
    expect(contextDelta).toEqual({
        type: "context.delta",
        content: `[GSV EVENT]\n${formatContextProjectionEvent(
          scenario.initialProjection,
          scenario.transition.projection,
        )}`,
      });
  });
});

function toolCall(id: string, input: string): ToolCall {
  return {
    type: "toolCall",
    id,
    name: "Shell",
    arguments: { input },
  };
}

function assistant(call: ToolCall): AssistantMessage {
  return {
    role: "assistant",
    content: [call],
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
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
