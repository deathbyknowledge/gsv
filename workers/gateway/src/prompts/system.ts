import runtimeContext from "./system/01-gsv.md";
import targetContext from "./system/05-targets.md";
import runtimeFacts from "./system/00-runtime.md";
import responsibilityContext from "./system/10-responsibilities.md";
import discoveryContext from "./system/20-discovery.md";
import orchestrationContext from "./system/30-process-orchestration.md";
import delegatedTaskContext from "./tasks/delegated.md";

// Used by ConfigStore defaults for config/ai/context.d/01-gsv.md.
export const GSV_RUNTIME_CONTEXT = runtimeContext.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/05-targets.md.
export const GSV_TARGET_CONTEXT = targetContext.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/00-runtime.md.
export const GSV_RUNTIME_FACTS = runtimeFacts.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/10-responsibilities.md.
export const GSV_RESPONSIBILITY_CONTEXT = responsibilityContext.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/20-discovery.md.
export const GSV_CONTEXT_DISCOVERY = discoveryContext.trimEnd();

// Used by ConfigStore defaults for config/ai/context.d/30-process-orchestration.md.
export const GSV_PROCESS_ORCHESTRATION = orchestrationContext.trimEnd();

export const GSV_DELEGATED_TASK_CONTEXT = delegatedTaskContext.trimEnd();
