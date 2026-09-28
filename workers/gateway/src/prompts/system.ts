import worldContext from "./world-model/gsv.md";
import eventContext from "./interaction/events.md";
import messageContext from "./interaction/messages.md";
import targetContext from "./computer-and-discovery/targets.md";
import runtimeFacts from "./instance-facts/runtime.md";
import contextContinuity from "./durable-work/continuity.md";
import responsibilityContext from "./durable-work/responsibilities.md";
import responsibilityFacts from "./instance-facts/responsibilities.md";
import discoveryContext from "./computer-and-discovery/discovery.md";
import orchestrationContext from "./durable-work/processes.md";
import delegatedTaskContext from "./tasks/delegated.md";

// Used by ConfigStore defaults for config/ai/context.d/01-gsv.md.
export const GSV_RUNTIME_CONTEXT = [worldContext, eventContext].map((text) => text.trimEnd()).join("\n\n");

// Used by ConfigStore defaults for config/ai/context.d/05-targets.md.
export const GSV_TARGET_CONTEXT = [messageContext, targetContext].map((text) => text.trimEnd()).join("\n");

// Used by ConfigStore defaults for config/ai/context.d/00-runtime.md.
export const GSV_RUNTIME_FACTS = runtimeFacts.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/10-responsibilities.md.
export const GSV_RESPONSIBILITY_CONTEXT = [contextContinuity, responsibilityContext, responsibilityFacts].map((text) => text.trimEnd()).join("\n\n");

// Used by ConfigStore defaults for config/ai/context.d/20-discovery.md.
export const GSV_CONTEXT_DISCOVERY = discoveryContext.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/30-process-orchestration.md.
export const GSV_PROCESS_ORCHESTRATION = orchestrationContext.trimEnd();

export const GSV_DELEGATED_TASK_CONTEXT = delegatedTaskContext.trimEnd();
