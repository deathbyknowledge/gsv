import type {
  SocialChannelItem,
  SocialMessageWorkflowItem,
  SocialState,
  UpdateMessageWorkflowArgs,
} from "../types";

export type InboxFilter = "active" | "needs-human" | "all";

export const ACTIVE_WORKFLOW_STATES = new Set<SocialMessageWorkflowItem["state"]>([
  "received",
  "triaged",
  "in_progress",
  "needs_human",
]);

export const MESSAGE_WORKFLOW_OPTIONS: Array<{ state: UpdateMessageWorkflowArgs["state"]; label: string }> = [
  { state: "triaged", label: "Triaged" },
  { state: "in_progress", label: "In progress" },
  { state: "needs_human", label: "Needs human" },
  { state: "completed", label: "Completed" },
  { state: "declined", label: "Declined" },
  { state: "failed", label: "Failed" },
];

export function isActiveWorkflow(state: SocialMessageWorkflowItem["state"]): boolean {
  return ACTIVE_WORKFLOW_STATES.has(state);
}

export function filterInboxWorkflows(
  workflows: SocialMessageWorkflowItem[],
  filter: InboxFilter,
): SocialMessageWorkflowItem[] {
  const inbound = workflows.filter((workflow) => workflow.direction === "inbound");
  if (filter === "active") {
    return inbound.filter((workflow) => isActiveWorkflow(workflow.state));
  }
  if (filter === "needs-human") {
    return inbound.filter((workflow) => workflow.state === "needs_human");
  }
  return inbound;
}

export function getAttentionCounts(state: SocialState | null): {
  active: number;
  needsHuman: number;
  channels: number;
  contacts: number;
  publishedRecords: number;
} {
  const workflows = state?.messageWorkflows ?? [];
  const inbound = workflows.filter((workflow) => workflow.direction === "inbound");
  const active = inbound.filter((workflow) => isActiveWorkflow(workflow.state)).length;
  return {
    active,
    needsHuman: inbound.filter((workflow) => workflow.state === "needs_human").length,
    channels: state?.channels.length ?? 0,
    contacts: state?.contacts.length ?? 0,
    publishedRecords: state?.contacts.length ?? 0,
  };
}

export function channelAttentionCount(channel: SocialChannelItem, workflows: SocialMessageWorkflowItem[]): number {
  return workflows.filter((workflow) =>
    workflow.channelId === channel.channelId &&
    workflow.direction === "inbound" &&
    isActiveWorkflow(workflow.state)
  ).length;
}

export function workflowContactHandle(workflow: SocialMessageWorkflowItem): string {
  return workflow.direction === "inbound" ? workflow.fromHandle : workflow.toHandle;
}

export function workflowStateLabel(value: string): string {
  return value.replace(/_/g, " ");
}
