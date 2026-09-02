import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { isValidCapability } from "../../workers/gateway/src/kernel/capabilities";
import type {
  GsvEvaluationPredicate,
  GsvSurfaceScenario,
} from "./schema";

const optionalJsonObjectSchema = z.custom<z.infer<typeof jsonObjectSchema>>(
  (value) => jsonObjectSchema.safeParse(value).success,
);
const optionalJsonValueSchema = z.custom<JsonValue>(
  (value) => jsonValueSchema.safeParse(value).success,
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
  driver: z.string().min(1).optional(),
  driverConfig: optionalJsonObjectSchema.optional(),
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

const evaluationPredicateSchema: z.ZodType<GsvEvaluationPredicate> = z.lazy(() => (
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("match"),
      path: z.string(),
      mode: z.enum(["equals", "subset"]).default("subset"),
      value: jsonValueSchema,
    }).strict(),
    z.object({
      type: z.literal("count"),
      path: z.string(),
      where: optionalJsonValueSchema.optional(),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    }).strict().refine(
      ({ min, max }) => min !== undefined || max !== undefined,
      "count requires min or max",
    ).refine(
      ({ min, max }) => min === undefined || max === undefined || min <= max,
      "count min cannot exceed max",
    ),
    z.object({
      type: z.literal("order"),
      path: z.string(),
      before: jsonValueSchema,
      after: jsonValueSchema,
    }).strict(),
    z.object({
      type: z.literal("sequence"),
      path: z.string(),
      items: z.array(jsonValueSchema).min(2),
    }).strict(),
    z.object({
      type: z.enum(["all", "any"]),
      predicates: z.array(evaluationPredicateSchema).min(1),
    }).strict(),
    z.object({
      type: z.literal("not"),
      predicate: evaluationPredicateSchema,
    }).strict(),
  ])
));

const scenarioSchema = z.object({
  schemaVersion: z.literal(3),
  id: z.string().min(1),
  seed: z.string().min(1),
  family: z.string().min(1).default("standalone"),
  tags: z.array(z.string().min(1)).default([]),
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
    adapters: z.array(adapterSchema).default([]),
  }).strict(),
  components: z.object({
    targets: z.array(targetSchema).default([]),
    transitions: z.array(transitionSchema).default([]),
    events: z.array(externalEventSchema).default([]),
  }).strict(),
  groundTruth: optionalJsonObjectSchema.default({}),
  evaluation: z.object({
    milestones: z.array(z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      dimension: z.string().min(1),
      weight: z.number().positive(),
      requires: z.array(z.string().min(1)).default([]),
      requiredForStrict: z.boolean().default(true),
      predicates: z.array(evaluationPredicateSchema).min(1),
    }).strict()).min(1),
    constraints: z.array(z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      severity: z.enum(["hard", "advisory"]),
      predicate: evaluationPredicateSchema,
    }).strict()).default([]),
  }).strict(),
  maxTurns: z.number().int().positive().max(50),
  maxRuns: z.number().int().positive().max(20).default(1),
}).strict();

export function parseGsvSurfaceScenario(value: JsonValue): GsvSurfaceScenario {
  const scenario = scenarioSchema.parse(value);
  requireUnique([
    ...scenario.world.processes.map(({ id }) => id),
    ...(scenario.world.delegates ?? []).map(({ process }) => process.id),
  ], "process");
  requireUnique(scenario.world.delegates.map(({ account }) => account), "delegate account");
  requireUnique(scenario.components.targets.map(({ id }) => id), "target");
  requireUnique(scenario.world.adapters.map(({ id }) => id), "adapter");
  requireUnique(scenario.components.transitions.map(({ id }) => id), "transition");
  requireUnique(scenario.components.events.map(({ id }) => id), "external event");
  requireUnique(scenario.evaluation.milestones.map(({ id }) => id), "milestone");
  requireUnique(scenario.evaluation.constraints.map(({ id }) => id), "constraint");
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
  for (const target of scenario.components.targets) {
    if (target.id === "gsv") {
      throw new Error("The native gsv target is implicit");
    }
    requireCapabilities(target.implements ?? [], "target " + target.id);
  }
  for (const transition of scenario.components.transitions) {
    if (!allProcessIds(scenario).has(transition.after.processId)) {
      throw new Error("Transition does not name a synthetic process: " + transition.id);
    }
    requireTargetEffects(scenario, transition.id, transition.effects);
  }
  for (const event of scenario.components.events) {
    if (!scenario.world.processes.some(({ id }) => id === event.processId)) {
      throw new Error("External event does not name an initial process: " + event.id);
    }
    requireTargetEffects(scenario, event.id, event.effects);
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
  requireAcyclicMilestones(scenario);
  return scenario;
}

function allProcessIds(scenario: GsvSurfaceScenario): Set<string> {
  return new Set([
    ...scenario.world.processes.map(({ id }) => id),
    ...(scenario.world.delegates ?? []).map(({ process }) => process.id),
  ]);
}

function requireTargetEffects(
  scenario: GsvSurfaceScenario,
  owner: string,
  effects: readonly { targetId: string }[],
): void {
  const targetIds = new Set(scenario.components.targets.map(({ id }) => id));
  for (const effect of effects) {
    if (!targetIds.has(effect.targetId)) {
      throw new Error("Scenario component effect does not name a target: " + owner);
    }
  }
}

function requireAcyclicMilestones(scenario: GsvSurfaceScenario): void {
  const milestones = new Map(
    scenario.evaluation.milestones.map((milestone) => [milestone.id, milestone]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Evaluation milestone dependency cycle at: " + id);
    const milestone = milestones.get(id);
    if (!milestone) throw new Error("Unknown evaluation milestone dependency: " + id);
    visiting.add(id);
    for (const required of milestone.requires) visit(required);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of milestones.keys()) visit(id);
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
