import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { isValidCapability } from "../../workers/gateway/src/kernel/capabilities";
import type { GsvSurfaceScenario } from "./schema";

const optionalJsonObjectSchema = z.custom<z.infer<typeof jsonObjectSchema>>(
  (value) => jsonObjectSchema.safeParse(value).success,
);

const processSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["ship", "worker"]),
  uid: z.number().int().nonnegative(),
  gids: z.array(z.number().int().nonnegative()),
  capabilities: z.array(z.string()),
}).strict();

const targetEffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state.set"),
    key: z.string().min(1),
    value: jsonValueSchema,
  }).strict(),
  z.object({
    type: z.literal("file.write"),
    path: z.string().min(1),
    content: z.string(),
  }).strict(),
  z.object({
    type: z.literal("file.delete"),
    path: z.string().min(1),
  }).strict(),
]);

const commandSchema = z.object({
  output: z.string(),
  exitCode: z.number().int().optional(),
  effects: z.array(targetEffectSchema).optional(),
}).strict();

const targetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["laptop", "server", "browser", "slack"]),
  ownerUid: z.number().int().nonnegative(),
  accessGids: z.array(z.number().int().nonnegative()),
  label: z.string().optional(),
  description: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
  online: z.boolean(),
  implements: z.array(z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  state: optionalJsonObjectSchema.optional(),
  commands: z.record(z.string(), commandSchema).optional(),
}).strict();

const transitionEffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("target.online"),
    targetId: z.string().min(1),
    online: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("target.access.grant"),
    targetId: z.string().min(1),
    gid: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("target.access.revoke"),
    targetId: z.string().min(1),
    gid: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("target.state.set"),
    targetId: z.string().min(1),
    key: z.string().min(1),
    value: jsonValueSchema,
  }).strict(),
  z.object({
    type: z.literal("target.file.write"),
    targetId: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
  }).strict(),
]);

const transitionSchema = z.object({
  id: z.string().min(1),
  after: z.object({
    processId: z.string().min(1),
    tool: z.string().min(1),
    arguments: optionalJsonObjectSchema.optional(),
    outcome: z.enum(["success", "error", "any"]).optional(),
  }).strict(),
  effects: z.array(transitionEffectSchema).min(1),
}).strict();

const semanticLogEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool.call"),
    processId: z.string(),
    name: z.string(),
    arguments: jsonObjectSchema,
  }).strict(),
  z.object({
    type: z.literal("tool.result"),
    processId: z.string(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("world.transition"),
    id: z.string(),
  }).strict(),
  z.object({
    type: z.literal("context.delta"),
    processId: z.string(),
    content: z.string(),
  }).strict(),
  z.object({
    type: z.literal("message.committed"),
    processId: z.string(),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("run.yielded"),
    processId: z.string(),
  }).strict(),
  z.object({
    type: z.literal("run.returned"),
    processId: z.string(),
    text: z.string(),
  }).strict(),
]);

const scenarioSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  prompt: z.string().min(1),
  entryProcessId: z.string().min(1),
  world: z.object({
    runtime: z.object({
      now: z.string().min(1),
      timezone: z.string().min(1),
    }).strict(),
    processes: z.array(processSchema).min(1),
    targets: z.array(targetSchema),
  }).strict(),
  transitions: z.array(transitionSchema).default([]),
  expected: jsonObjectSchema,
  expectedLog: z.array(semanticLogEntrySchema).optional(),
  maxTurns: z.number().int().positive().max(50),
}).strict();

export function parseGsvSurfaceScenario(value: JsonValue): GsvSurfaceScenario {
  const scenario = scenarioSchema.parse(value);
  requireUnique(scenario.world.processes.map(({ id }) => id), "process");
  requireUnique(scenario.world.targets.map(({ id }) => id), "target");
  requireUnique(scenario.transitions.map(({ id }) => id), "transition");
  if (!scenario.world.processes.some(({ id }) => id === scenario.entryProcessId)) {
    throw new Error("entryProcessId does not name a synthetic process");
  }
  for (const process of scenario.world.processes) {
    requireCapabilities(process.capabilities, "process " + process.id);
  }
  for (const target of scenario.world.targets) {
    if (target.id === "gsv") {
      throw new Error("The native gsv target is implicit");
    }
    requireCapabilities(target.implements ?? [], "target " + target.id);
  }
  return scenario;
}

function requireUnique(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error("Duplicate synthetic " + kind + " id: " + value);
    seen.add(value);
  }
}

function requireCapabilities(values: readonly string[], owner: string): void {
  for (const value of values) {
    if (!isValidCapability(value)) {
      throw new Error("Invalid capability for " + owner + ": " + value);
    }
  }
}
