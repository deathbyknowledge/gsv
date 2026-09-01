import {
  adapterDeliveryContextSchema,
  type AdapterGatewayRequestFrame,
  type AdapterGatewayResponseFrame,
  type AdapterOutboundMessage,
  type AdapterDeliveryContext,
  type AdapterProviderSendResult,
} from "../../../../packages/gsv/src/protocol/adapters.js";
import { cancelBinaryBody } from "../../../../packages/gsv/src/protocol/adapter-media-body.js";
import type { BinaryBody } from "../../../../packages/gsv/src/protocol/body.js";
import type {
  AdapterSendArgs,
  AdapterSendResult,
} from "../../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { adapterSendArgsSchema } from "../../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { renderAdapterSend, type RenderedAdapterSend } from "./peer-render";

export type AdapterFrameHandlers = {
  send(delivery: RenderedAdapterSend, body?: BinaryBody): Promise<AdapterProviderSendResult>;
};

/** Validate and dispatch one canonical Gateway-to-adapter frame. */
export async function handleAdapterFrame(
  adapterId: string,
  inputContext: AdapterDeliveryContext,
  inputFrame: AdapterGatewayRequestFrame,
  handlers: AdapterFrameHandlers,
): Promise<AdapterGatewayResponseFrame> {
  let context: AdapterDeliveryContext;
  try {
    context = adapterDeliveryContextSchema.parse(inputContext);
  } catch (error) {
    await cancelBinaryBody(inputFrame.body, error);
    throw error;
  }
  if (inputFrame.call !== "adapter.send") {
    await cancelBinaryBody(inputFrame.body, "Adapter does not implement this request");
    return errorFrame(inputFrame.id, 404, `Adapter does not implement ${inputFrame.call}`);
  }

  let args: AdapterSendArgs;
  try {
    args = adapterSendArgsSchema.parse(inputFrame.args);
    validateSendContext(adapterId, context, args);
  } catch (error) {
    await cancelBinaryBody(inputFrame.body, error);
    return errorFrame(
      inputFrame.id,
      400,
      error instanceof Error ? error.message : "Invalid adapter.send request",
    );
  }

  const message: AdapterOutboundMessage = {
    deliveryId: context.deliveryId,
    surface: args.surface,
    text: args.text,
  };
  if (context.actorId) message.actorId = context.actorId;
  if (context.routeGeneration) message.routeGeneration = context.routeGeneration;
  if (args.replyToId !== undefined) message.replyToId = args.replyToId;
  if (args.media !== undefined) message.media = args.media;
  const delivery = renderAdapterSend(context, message);

  let result: AdapterProviderSendResult;
  try {
    result = await handlers.send(delivery, inputFrame.body);
  } catch {
    return errorFrame(inputFrame.id, 503, "Adapter delivery is unavailable", true);
  } finally {
    await cancelBinaryBody(inputFrame.body, "Adapter request completed");
  }
  return {
    type: "res",
    id: inputFrame.id,
    ok: true,
    data: publicSendResult(adapterId, context, result),
  };
}

function validateSendContext(
  adapterId: string,
  context: AdapterDeliveryContext,
  args: AdapterSendArgs,
): void {
  if (
    args.adapter.trim().toLowerCase() !== adapterId
    || args.accountId !== context.accountId
    || args.deliveryId !== context.deliveryId
    || args.surface.kind !== context.surface.kind
    || args.surface.id !== context.surface.id
    || (args.surface.threadId ?? "") !== (context.surface.threadId ?? "")
  ) {
    throw new Error("adapter.send request does not match its trusted route context");
  }
  if (
    context.hil
    && (
      !context.actorId
      || !context.processId
      || !context.runId
      || context.hil.pid !== context.processId
      || context.hil.runId !== context.runId
      || context.deliveryId !== `${context.runId}:hil:${context.hil.requestId}`
    )
  ) {
    throw new Error("Adapter HIL request does not match its trusted route context");
  }
}

function publicSendResult(
  adapter: string,
  context: AdapterDeliveryContext,
  result: AdapterProviderSendResult,
): AdapterSendResult {
  if (!result.ok) {
    if (result.ambiguous) {
      return {
        ok: true,
        adapter,
        accountId: context.accountId,
        surfaceId: context.surface.id,
        deliveryId: context.deliveryId,
        deliveryState: "ambiguous",
      };
    }
    return {
      ok: false,
      error: result.error,
      deliveryId: context.deliveryId,
      retryable: result.retryable === true,
    };
  }
  return {
    ok: true,
    adapter,
    accountId: context.accountId,
    surfaceId: context.surface.id,
    deliveryId: context.deliveryId,
    ...(result.messageId === undefined ? undefined : { messageId: result.messageId }),
    deliveryState: result.deduplicated ? "deduplicated" : "sent",
  };
}

function errorFrame(
  id: string,
  code: number,
  message: string,
  retryable = false,
): AdapterGatewayResponseFrame {
  return {
    type: "res",
    id,
    ok: false,
    error: { code, message, ...(retryable ? { retryable: true } : undefined) },
  };
}
