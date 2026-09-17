import { describe, expect, it } from "vitest";
import type { AiDecideResult } from "@humansandmachines/gsv/protocol";
import { composeWorkspace, type WorkspaceSource } from "./workspaceService";

const sources: WorkspaceSource[] = [
  { id: "conversation", kind: "conversation", title: "Conversation" },
  { id: "note", kind: "memory", title: "Knowledge graph", repo: "sam/personal", path: "pages/graph.md" },
  { id: "file", kind: "file", title: "Notes", target: "gsv", path: "/home/sam/notes.md" },
];
function decision(primary: string, layout: string): AiDecideResult {
  return { provider: "typesafe", model: "jev-latest", usage: { inputTokens: 1, outputTokens: 1 }, answers: {
    primary: { type: "choice", choice: primary, confidence: 0.9, probabilities: {} },
    layout: { type: "choice", choice: layout, confidence: 0.9, probabilities: {} },
  } };
}
describe("workspace composition", () => {
  it("retains pinned sources when the model asks for only one view", () => {
    expect(composeWorkspace(decision("file", "focus"), sources, ["conversation", "note"]))
      .toEqual({ layout: "lead", sources: ["file", "conversation", "note"] });
  });
  it("accepts only supplied resources and supported layouts", () => {
    expect(composeWorkspace(decision("private-other-space", "executable-html"), sources, ["private-other-space"]))
      .toEqual({ layout: "focus", sources: ["conversation"] });
  });
  it("does not reintroduce a dismissed source when selection is malformed", () => {
    expect(composeWorkspace(decision("conversation", "focus"), sources.slice(1), [])).toEqual({ layout: "focus", sources: ["note"] });
  });
  it("adds useful supporting context without adding low relevance sources", () => {
    const result = decision("conversation", "split");
    result.answers.relevance_1 = { type: "score", score: 2.8, confidence: 0.9, probabilities: {} };
    result.answers.relevance_2 = { type: "score", score: 0.2, confidence: 0.9, probabilities: {} };
    expect(composeWorkspace(result, sources, [])).toEqual({ layout: "split", sources: ["conversation", "note"] });
  });
});
