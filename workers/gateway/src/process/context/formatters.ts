/** Internal Process formatters primitives. */

import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import { PROCESS_TASK_SCHEMA, type ProcessTask } from "../run/helpers";

export function decodeProcessTask(callback: string, payloadJson: string): ProcessTask {
  return PROCESS_TASK_SCHEMA.parse({
    callback,
    payload: JSON.parse(payloadJson),
  });
}

export function formatAiModelStackLabel(
  config: Pick<AiConfigResult, "provider" | "model">,
): string {
  return `${config.provider}/${config.model}`;
}
