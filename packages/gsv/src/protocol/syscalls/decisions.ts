import type { JsonObject, JsonValue } from "../json";

/** Structured evidence shared by independently evaluated questions. */
export type AiDecisionState = string | JsonObject | JsonValue[];

export type AiDecisionQuestion =
  | { type: "boolean"; instructions: AiDecisionState; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: AiDecisionState; criteria: Record<string, string | null> }
  | { type: "score"; instructions: AiDecisionState; criteria: string[] };

/** Credentials come from the caller's owner-scoped decision configuration. */
export type AiDecideArgs = {
  state: AiDecisionState;
  questions: Record<string, AiDecisionQuestion>;
  model?: string;
  timeoutMs?: number;
};

export type AiDecisionAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export type AiDecideResult = {
  provider: string;
  model: string;
  answers: Record<string, AiDecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number };
};
