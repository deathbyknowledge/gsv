import type { ProcHilRequest } from "../../../../packages/gsv/src/protocol/syscalls/proc.js";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  attachAdapterHilApprovalMessage,
  prepareAdapterHilApproval,
  submitAdapterHilApproval,
  type AdapterHilResolution,
} from "../../shared/src/hil-approval";
import {
  createAdapterHilPresentation,
  renderAdapterHilPrompt,
} from "../../shared/src/peer-render";
import type {
  AdapterInstallationContext,
  AdapterDeliveryContext,
} from "./types";
import {
  buildSlackApprovalBlocks,
  buildSlackApprovalStatusMessage,
  canRenderSlackApproval,
  type SlackApprovalCallback,
  type SlackApprovalSubmittedMessage,
  type SlackBlock,
} from "./slack-interactions";

export type SlackApprovalControls = {
  token: string;
  text: string;
  blocks: SlackBlock[];
};

export type SlackApprovalApi = {
  updateMessage(
    callback: SlackApprovalCallback,
    message: SlackApprovalSubmittedMessage,
  ): Promise<void>;
};

const PROVIDER = "slack";

export async function prepareSlackApproval(
  storage: DurableObjectStorage,
  teamId: string,
  context: AdapterDeliveryContext,
  request: ProcHilRequest,
): Promise<SlackApprovalControls | null> {
  const presentation = createAdapterHilPresentation(context, request);
  const text = renderAdapterHilPrompt(presentation, "native");
  if (!canRenderSlackApproval(text)) return null;
  const token = await prepareAdapterHilApproval(
    storage,
    PROVIDER,
    teamId,
    context,
    request,
    presentation,
  );
  if (!token) return null;
  const blocks = buildSlackApprovalBlocks(text, token);
  if (!blocks) throw new Error("Slack approval controls are invalid");
  return { token, text, blocks };
}

export async function attachSlackApprovalMessage(
  storage: DurableObjectStorage,
  token: string,
  providerMessageId: string | undefined,
): Promise<void> {
  await attachAdapterHilApprovalMessage(storage, PROVIDER, token, providerMessageId);
}

export async function handleSlackApprovalCallback(
  storage: DurableObjectStorage,
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  callback: SlackApprovalCallback,
  api: SlackApprovalApi,
): Promise<void> {
  const submission = await submitAdapterHilApproval(
    storage,
    gateway,
    installation,
    {
      provider: PROVIDER,
      token: callback.token,
      binding: callback.teamId,
      actorId: callback.actorId,
      surface: callback.surface,
      providerMessageId: callback.sourceMessageId,
      interactionId: callback.interactionId,
      decision: callback.action === "deny" ? "deny" : "approve",
      remember: callback.action === "approve_always",
    },
  );

  const status = submission.kind === "invalid"
    ? "This approval is no longer available."
    : submission.kind === "processing"
      ? "This approval is already being handled."
      : resolutionStatus(submission.resolution);
  const presentation = submission.kind === "invalid"
    ? undefined
    : submission.presentation;
  await api.updateMessage(
    callback,
    buildSlackApprovalStatusMessage(presentation, status),
  ).catch(() => undefined);
}

function resolutionStatus(resolution: AdapterHilResolution | undefined): string {
  switch (resolution) {
    case "approve": return "Approved once.";
    case "approve_always": return "Approved for this conversation.";
    case "deny": return "Denied.";
    default: return "This approval is no longer pending.";
  }
}
