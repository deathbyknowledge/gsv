import { z } from "zod";
import { bodyToBytes, type AiDecideResult, type AiDecisionAnswer } from "@humansandmachines/gsv/protocol";
import type { InferenceDecisionRequest } from "@humansandmachines/gsv/services/inference-execution";

const state = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const question = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("boolean"), instructions: state,
    criteria: z.strictObject({ true: z.string(), false: z.string() }).optional() }),
  z.strictObject({ type: z.literal("choice"), instructions: state,
    criteria: z.record(z.string().min(1).max(4096), z.string().nullable())
      .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255) }),
  z.strictObject({ type: z.literal("score"), instructions: state,
    criteria: z.array(z.string().min(1)).min(2).max(255) }),
]);
const inputSchema = z.strictObject({
  state,
  questions: z.record(z.string().min(1).max(200), question)
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64),
});
const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities, confidence: probability }),
  z.object({ type: z.literal("score"), score: z.number().nonnegative(), probabilities, confidence: probability }),
]);
const responseSchema = z.object({
  model: z.string().min(1).max(200),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

/** Provider-specific execution; only the trusted executor receives credentials. */
export async function evaluateTypeSafe(
  request: InferenceDecisionRequest,
  signal: AbortSignal,
  providerFetch: typeof fetch = fetch,
): Promise<AiDecideResult> {
  if (request.connection.provider !== "typesafe" || !request.connection.apiKey.trim()) {
    throw new Error("TypeSafe decision credentials are not configured");
  }
  const parsed = inputSchema.safeParse(request.input);
  if (!parsed.success) throw new Error("Invalid decision questions or state");
  const model = request.connection.model.trim();
  if (!model || model.length > 200) throw new Error("Invalid decision model");
  const questions = Object.fromEntries(Object.entries(parsed.data.questions).map(([id, value]) => [id, {
    ...value, type: value.type === "boolean" ? "noul" : value.type,
  }]));
  const body = JSON.stringify({ model, state: parsed.data.state, questions });
  if (new TextEncoder().encode(body).byteLength > 128 * 1024) throw new Error("Decision request exceeds 128 KiB");
  signal.throwIfAborted();
  const response = await providerFetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Authorization": `Bearer ${request.connection.apiKey}`, "Content-Type": "application/json" },
    body,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // Error bodies may repeat evidence or credentials. Keep them out of history.
    throw new Error(`TypeSafe decision request failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("TypeSafe returned an empty decision response");
  const bytes = await bodyToBytes({ stream: response.body }, 1024 * 1024, signal);
  let wire: unknown;
  try { wire = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("TypeSafe returned an invalid decision response"); }
  const result = responseSchema.safeParse(wire);
  if (!result.success) throw new Error("TypeSafe returned an invalid decision response");
  const answers: Array<[string, AiDecisionAnswer]> = [];
  const expected = Object.entries(parsed.data.questions);
  if (Object.keys(result.data.answers).length !== expected.length) throw new Error("TypeSafe returned mismatched decision answers");
  for (const [id, question] of expected) {
    const answer = result.data.answers[id];
    if (question.type === "boolean" && answer?.type === "noul") {
      answers.push([id, { type: "boolean", probability: answer.noul }]);
      continue;
    }
    if ((question.type !== "choice" && question.type !== "score") || !answer || (answer.type !== "choice" && answer.type !== "score") || answer.type !== question.type) {
      throw new Error("TypeSafe returned mismatched decision answers");
    }
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (!validDistribution(answer.probabilities, keys)) throw new Error("TypeSafe returned an invalid decision distribution");
    if (answer.type === "choice") {
      if (!keys.includes(answer.choice)) throw new Error("TypeSafe selected an unknown decision option");
      answers.push([id, answer]);
    } else {
      if (answer.score > keys.length - 1) throw new Error("TypeSafe returned an invalid decision score");
      answers.push([id, answer]);
    }
  }
  signal.throwIfAborted();
  return {
    provider: "typesafe", model: result.data.model, answers: Object.fromEntries(answers),
    usage: { inputTokens: result.data.usage.input_tokens, outputTokens: result.data.usage.output_tokens },
  };
}

function validDistribution(values: Record<string, number>, keys: string[]): boolean {
  return Object.keys(values).length === keys.length
    && keys.every((key) => Object.hasOwn(values, key))
    && Math.abs(Object.values(values).reduce((sum, value) => sum + value, 0) - 1) <= 0.001;
}
