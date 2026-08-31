import {
  adapterPeerDeliveryContextSchema,
  adapterPeerSignalFrameSchema,
  type AdapterGatewayFrame,
  type AdapterInstallationContext,
  type AdapterOutboundMessage,
  type AdapterPeerDeliveryContext,
  type AdapterPeerSignalFrame,
  type AdapterProviderSendResult,
} from "../../../packages/gsv/src/protocol/adapters.js";
import { cancelBinaryBody } from "../../../packages/gsv/src/protocol/adapter-media-body.js";
import type { BinaryBody } from "../../../packages/gsv/src/protocol/body.js";
import type {
  AdapterSendArgs,
  AdapterSendResult,
} from "../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { adapterSendArgsSchema } from "../../../packages/gsv/src/protocol/syscalls/adapter.js";

export type AdapterFrameHandlers = {
  send(message: AdapterOutboundMessage, body?: BinaryBody): Promise<AdapterProviderSendResult>;
  acceptSignal(
    context: AdapterPeerDeliveryContext,
    frame: AdapterPeerSignalFrame,
    body?: BinaryBody,
  ): Promise<void>;
};

/** Validate and dispatch one canonical Gateway-to-adapter frame. */
export async function handleAdapterFrame(
  adapterId: string,
  _installation: AdapterInstallationContext,
  inputContext: AdapterPeerDeliveryContext,
  inputFrame: AdapterGatewayFrame,
  signalBody: BinaryBody | undefined,
  handlers: AdapterFrameHandlers,
): Promise<AdapterGatewayFrame | null> {
  let context: AdapterPeerDeliveryContext;
  try {
    context = adapterPeerDeliveryContextSchema.parse(inputContext);
  } catch (error) {
    await Promise.all([
      cancelBinaryBody(signalBody, error),
      inputFrame.type === "req" ? cancelBinaryBody(inputFrame.body, error) : Promise.resolve(),
    ]);
    throw error;
  }
  if (inputFrame.type === "sig") {
    try {
      const frame = adapterPeerSignalFrameSchema.parse(inputFrame);
      validateSignalContext(context, frame);
      await handlers.acceptSignal(context, frame, signalBody);
      return null;
    } catch (error) {
      await cancelBinaryBody(signalBody, error);
      throw error;
    }
  }

  if (signalBody) {
    await cancelBinaryBody(signalBody, "Request frames carry their body on the frame");
    throw new Error("Adapter request supplied an invalid body sidecar");
  }
  if (inputFrame.type !== "req") return null;
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

  let result: AdapterProviderSendResult;
  try {
    result = await handlers.send(message, inputFrame.body);
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

function validateSignalContext(
  context: AdapterPeerDeliveryContext,
  frame: AdapterPeerSignalFrame,
): void {
  if (!context.actorId || !context.processId || !context.runId) {
    throw new Error("Adapter signal route context is incomplete");
  }
  if (frame.signal === "proc.run.hil.requested") {
    if (
      frame.payload.pid !== context.processId
      || frame.payload.runId !== context.runId
      || context.deliveryId !== `${context.runId}:hil:${frame.payload.requestId}`
    ) {
      throw new Error("Adapter HIL signal does not match its route context");
    }
    return;
  }
  const message = frame.payload.message;
  if (
    message.id !== context.deliveryId
    || message.processId !== context.processId
    || message.runId !== context.runId
    || message.author.kind !== "process"
    || message.author.pid !== context.processId
  ) {
    throw new Error("Committed Message signal does not match its route context");
  }
}

function validateSendContext(
  adapterId: string,
  context: AdapterPeerDeliveryContext,
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
}

function publicSendResult(
  adapter: string,
  context: AdapterPeerDeliveryContext,
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
): AdapterGatewayFrame {
  return {
    type: "res",
    id,
    ok: false,
    error: { code, message, ...(retryable ? { retryable: true } : undefined) },
  };
}
