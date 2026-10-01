import computerDiscovery from "../../workers/gateway/src/prompts/computer-and-discovery/discovery.md";
import computerTargets from "../../workers/gateway/src/prompts/computer-and-discovery/targets.md";
import processWork from "../../workers/gateway/src/prompts/durable-work/processes.md";
import responsibilityRules from "../../workers/gateway/src/prompts/durable-work/responsibilities.md";
import responsibilityFacts from "../../workers/gateway/src/prompts/instance-facts/responsibilities.md";
import runtimeFacts from "../../workers/gateway/src/prompts/instance-facts/runtime.md";
import delegationFacts from "../../workers/gateway/src/prompts/instance-facts/ship.md";
import ownerFacts from "../../workers/gateway/src/prompts/instance-facts/user.md";
import interaction from "../../workers/gateway/src/prompts/interaction/shared.md";
import sharedKnowledge from "../../workers/gateway/src/prompts/knowledge/shared.md";
import onboardingWelcome from "../../workers/gateway/src/prompts/onboarding/welcome.md";
import crewRole from "../../workers/gateway/src/prompts/role-and-judgment/crew.md";
import shipRole from "../../workers/gateway/src/prompts/role-and-judgment/ship.md";
import compactionTask from "../../workers/gateway/src/prompts/tasks/compaction.md";
import delegatedTask from "../../workers/gateway/src/prompts/tasks/delegated.md";
import setupTask from "../../workers/gateway/src/prompts/tasks/setup-assist.md";
import yieldTask from "../../workers/gateway/src/prompts/tasks/yield-correction.md";
import shipVoice from "../../workers/gateway/src/prompts/voice/ship.md";
import worldModel from "../../workers/gateway/src/prompts/world-model/gsv.md";

export type PromptSourceScope = "shared" | "ship" | "crew" | "owner" | "task";
export type PromptSource = { path: string; text: string; scope: PromptSourceScope };

// Source categories are independent of saved context.d paths and their assembly order.
export const PROMPT_SOURCES: PromptSource[] = [
  { path: "computer-and-discovery/discovery.md", text: computerDiscovery, scope: "shared" },
  { path: "computer-and-discovery/targets.md", text: computerTargets, scope: "shared" },
  { path: "durable-work/processes.md", text: processWork, scope: "shared" },
  { path: "durable-work/responsibilities.md", text: responsibilityRules, scope: "shared" },
  { path: "instance-facts/responsibilities.md", text: responsibilityFacts, scope: "shared" },
  { path: "instance-facts/runtime.md", text: runtimeFacts, scope: "shared" },
  { path: "instance-facts/ship.md", text: delegationFacts, scope: "ship" },
  { path: "instance-facts/user.md", text: ownerFacts, scope: "owner" },
  { path: "interaction/shared.md", text: interaction, scope: "shared" },
  { path: "knowledge/shared.md", text: sharedKnowledge, scope: "shared" },
  { path: "onboarding/welcome.md", text: onboardingWelcome, scope: "task" },
  { path: "role-and-judgment/crew.md", text: crewRole, scope: "crew" },
  { path: "role-and-judgment/ship.md", text: shipRole, scope: "ship" },
  { path: "tasks/compaction.md", text: compactionTask, scope: "task" },
  { path: "tasks/delegated.md", text: delegatedTask, scope: "task" },
  { path: "tasks/setup-assist.md", text: setupTask, scope: "task" },
  { path: "tasks/yield-correction.md", text: yieldTask, scope: "task" },
  { path: "voice/ship.md", text: shipVoice, scope: "ship" },
  { path: "world-model/gsv.md", text: worldModel, scope: "shared" },
];

export const CONTEXT_SOURCE_PATHS = new Map<string, string[]>([
  ["system/00-runtime.md", ["instance-facts/runtime.md"]],
  ["system/01-gsv.md", ["world-model/gsv.md", "interaction/shared.md"]],
  ["system/05-targets.md", ["computer-and-discovery/targets.md"]],
  ["system/10-responsibilities.md", ["durable-work/responsibilities.md", "instance-facts/responsibilities.md"]],
  ["system/20-discovery.md", ["computer-and-discovery/discovery.md"]],
  ["system/30-process-orchestration.md", ["durable-work/processes.md"]],
  ["ship/00-role.md", ["role-and-judgment/ship.md", "knowledge/shared.md"]],
  ["ship/05-voice.md", ["voice/ship.md"]],
  ["ship/10-delegation.md", ["instance-facts/ship.md"]],
  ["crew/00-role.md", ["role-and-judgment/crew.md"]],
  ["crew/15-memory.md", ["knowledge/shared.md"]],
  ["user/10-personal.md", ["instance-facts/user.md"]],
]);
