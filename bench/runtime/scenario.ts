import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
  type ResponsibilityTransition,
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
  ownerUid: z.number().int().nonnegative().optional(),
  username: z.string().min(1).optional(),
  gids: z.array(z.number().int().nonnegative()),
  capabilities: z.array(z.string()),
}).strict();

const delegateSchema = z.object({
  account: z.string().min(1),
  process: processSchema.extend({ role: z.literal("worker") }),
  systemPrompt: z.string().min(1),
  maxTurns: z.number().int().positive().max(50),
}).strict();

const adapterSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("slack"),
  accountId: z.string().min(1),
  ownerUid: z.number().int().nonnegative(),
  connected: z.boolean(),
}).strict();

const adapterRouteSchema = z.object({
  adapterId: z.string().min(1),
  accountId: z.string().min(1),
  actorId: z.string().min(1),
  surface: z.object({
    kind: z.enum(["dm", "channel"]),
    id: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }).strict(),
  inboundDeliveryId: z.string().min(1),
  messageId: z.string().min(1),
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

const externalEventSchema = z.object({
  id: z.string().min(1),
  processId: z.string().min(1),
  delayMs: z.number().int().positive(),
  content: z.string().min(1),
  when: optionalJsonObjectSchema.optional(),
  effects: z.array(transitionEffectSchema).default([]),
  evictProcess: z.boolean().optional(),
}).strict();

const rubricAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("log_count"),
    entry: jsonObjectSchema,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }).strict().refine(
    ({ min, max }) => min !== undefined || max !== undefined,
    "log_count requires min or max",
  ).refine(
    ({ min, max }) => min === undefined || max === undefined || min <= max,
    "log_count min cannot exceed max",
  ),
  z.object({
    type: z.literal("log_order"),
    before: jsonObjectSchema,
    after: jsonObjectSchema,
  }).strict(),
]);

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
    type: z.literal("responsibility.transition"),
    transition: z.custom<ResponsibilityTransition>(),
  }).strict(),
  z.object({
    type: z.literal("process.spawned"),
    processId: z.string(),
    parentProcessId: z.string(),
    account: z.string(),
  }).strict(),
  z.object({
    type: z.literal("ipc.completed"),
    callId: z.string(),
    sourceProcessId: z.string(),
    targetProcessId: z.string(),
    resultText: z.string().optional(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("adapter.sent"),
    adapterId: z.string(),
    deliveryId: z.string(),
    processId: z.string(),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("run.started"),
    processId: z.string(),
    run: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("external.event"),
    id: z.string(),
    processId: z.string(),
    atMs: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("process.evicted"),
    processId: z.string(),
    afterRun: z.number().int().positive(),
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
  entryRoute: adapterRouteSchema.optional(),
  world: z.object({
    runtime: z.object({
      now: z.string().min(1),
      timezone: z.string().min(1),
    }).strict(),
    processes: z.array(processSchema).min(1),
    delegates: z.array(delegateSchema).default([]),
    targets: z.array(targetSchema),
    adapters: z.array(adapterSchema).default([]),
  }).strict(),
  transitions: z.array(transitionSchema).default([]),
  externalEvents: z.array(externalEventSchema).default([]),
  expected: jsonObjectSchema,
  rubric: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    weight: z.number().positive(),
    expected: jsonObjectSchema,
    assertions: z.array(rubricAssertionSchema).min(1).optional(),
  }).strict()).min(1),
  expectedLog: z.array(semanticLogEntrySchema).optional(),
  maxTurns: z.number().int().positive().max(50),
  maxRuns: z.number().int().positive().max(20).default(1),
}).strict();

export function parseGsvSurfaceScenario(value: JsonValue): GsvSurfaceScenario {
  const scenario = scenarioSchema.parse(value);
  requireUnique([
    ...scenario.world.processes.map(({ id }) => id),
    ...scenario.world.delegates.map(({ process }) => process.id),
  ], "process");
  requireUnique(scenario.world.delegates.map(({ account }) => account), "delegate account");
  requireUnique(scenario.world.targets.map(({ id }) => id), "target");
  requireUnique(scenario.world.adapters.map(({ id }) => id), "adapter");
  requireUnique(scenario.transitions.map(({ id }) => id), "transition");
  requireUnique(scenario.externalEvents.map(({ id }) => id), "external event");
  requireUnique(scenario.rubric.map(({ id }) => id), "rubric criterion");
  if (!scenario.world.processes.some(({ id }) => id === scenario.entryProcessId)) {
    throw new Error("entryProcessId does not name a synthetic process");
  }
  for (const process of scenario.world.processes) {
    requireCapabilities(process.capabilities, "process " + process.id);
  }
  for (const delegate of scenario.world.delegates) {
    requireCapabilities(
      delegate.process.capabilities,
      "delegate process " + delegate.process.id,
    );
  }
  for (const target of scenario.world.targets) {
    if (target.id === "gsv") {
      throw new Error("The native gsv target is implicit");
    }
    requireCapabilities(target.implements ?? [], "target " + target.id);
  }
  for (const event of scenario.externalEvents) {
    if (!scenario.world.processes.some(({ id }) => id === event.processId)) {
      throw new Error("External event does not name an initial process: " + event.id);
    }
    for (const effect of event.effects) {
      if (!scenario.world.targets.some(({ id }) => id === effect.targetId)) {
        throw new Error("External event effect does not name a target: " + event.id);
      }
    }
  }
  if (scenario.entryRoute) {
    const adapter = scenario.world.adapters.find(
      ({ id }) => id === scenario.entryRoute?.adapterId,
    );
    if (!adapter || adapter.accountId !== scenario.entryRoute.accountId) {
      throw new Error("entryRoute does not name a synthetic adapter account");
    }
    const entry = scenario.world.processes.find(
      ({ id }) => id === scenario.entryProcessId,
    );
    if (!entry || (entry.ownerUid ?? entry.uid) !== adapter.ownerUid) {
      throw new Error("entryRoute adapter owner does not own the entry process");
    }
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
