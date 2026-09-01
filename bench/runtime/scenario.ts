import {
  jsonValueSchema,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  parseContextProjection,
  type ContextProjection,
} from "../../workers/gateway/src/process/context/projection";
import type { GsvSurfaceScenario } from "./schema";

const semanticLogEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool.call"),
    name: z.literal("Shell"),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool.result"),
    name: z.literal("Shell"),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("context.delta"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("message.committed"),
    text: z.string(),
  }),
  z.object({ type: z.literal("run.yielded") }),
]);

const scenarioSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  systemPrompt: z.string().min(1),
  prompt: z.string().min(1),
  initialProjection: jsonValueSchema,
  transition: z.object({
    trigger: z.object({
      tool: z.literal("Shell"),
      input: z.string().min(1),
    }),
    projection: jsonValueSchema,
  }),
  shellResults: z.record(z.string(), z.string()),
  expectedLog: z.array(semanticLogEntrySchema),
  maxTurns: z.number().int().positive().max(20),
});

export function parseGsvSurfaceScenario(value: JsonValue): GsvSurfaceScenario {
  const parsed = scenarioSchema.parse(value);
  const initialProjection = requiredProjection(
    parsed.initialProjection,
    "initialProjection",
  );
  const projection = requiredProjection(
    parsed.transition.projection,
    "transition.projection",
  );
  return {
    ...parsed,
    initialProjection,
    transition: {
      ...parsed.transition,
      projection,
    },
    expectedLog: parsed.expectedLog,
  };
}

function requiredProjection(value: JsonValue, field: string): ContextProjection {
  const projection = parseContextProjection(value);
  if (!projection) throw new Error(`${field} is not a context projection`);
  return projection;
}
