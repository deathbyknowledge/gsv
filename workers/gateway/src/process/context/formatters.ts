/** Internal Process formatters primitives. */

import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import { PROCESS_TASK_SCHEMA, type ProcessTask } from "../run/helpers";
import type { ToolApprovalRule } from "../approval";

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

export function approvalRuleKey(rule: ToolApprovalRule): string {
  return JSON.stringify({
    match: rule.match,
    target: rule.target ?? null,
    action: rule.action,
  });
}
