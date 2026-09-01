import type { ContextProjection } from "../../workers/gateway/src/process/context/projection";

export type GsvSemanticLogEntry =
  | { type: "tool.call"; name: "Shell"; input: string }
  | { type: "tool.result"; name: "Shell"; content: string; isError: boolean }
  | { type: "context.delta"; content: string }
  | { type: "message.committed"; text: string }
  | { type: "run.yielded" };

export type GsvSurfaceScenario = {
  schemaVersion: 1;
  id: string;
  systemPrompt: string;
  prompt: string;
  initialProjection: ContextProjection;
  transition: {
    trigger: {
      tool: "Shell";
      input: string;
    };
    projection: ContextProjection;
  };
  shellResults: Record<string, string>;
  expectedLog: GsvSemanticLogEntry[];
  maxTurns: number;
};

export type GsvSurfaceObservation = {
  turn: number;
  systemPromptSha256: string;
  messages: unknown[];
  tools: unknown[];
};

export type GsvSurfaceArtifact = {
  schemaVersion: 1;
  scenarioId: string;
  status: "yielded" | "max_turns" | "invalid_action";
  transitionInjected: boolean;
  committedMessages: string[];
  observations: GsvSurfaceObservation[];
  log: GsvSemanticLogEntry[];
  error?: string;
};
