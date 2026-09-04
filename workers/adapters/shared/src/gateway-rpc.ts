import type { AdapterGatewayInterface } from "../../../../packages/gsv/src/protocol/adapters.js";
import { adapterInboundResultSchema } from "../../../../packages/gsv/src/protocol/adapters.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../../packages/gsv/src/protocol/json.js";
import type {
  AdapterInboundArgs,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
} from "../../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { adapterStateUpdateResultSchema } from "../../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { cancelBinaryBody } from "./media-body";
import type {
  AdapterInstallationContext,
  AdapterInboundResult,
  AdapterLinkedPeerContext,
  BinaryBody,
  GatewayFrame,
  GatewayRequestFrame,
} from "./types";
import {
  procHilResultSchema,
  type ProcHilArgs,
  type ProcHilResult,
} from "../../../../packages/gsv/src/protocol/syscalls/proc.js";
import * as z from "zod/mini";

export type AdapterGatewayBinding = AdapterGatewayInterface<GatewayFrame>;

/** Dispatch an ordinary request under a Kernel-derived linked-human peer. */
export async function callLinkedAdapterGateway(
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  context: AdapterLinkedPeerContext,
  call: "proc.hil",
  args: ProcHilArgs,
): Promise<ProcHilResult> {
  const frame: GatewayRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args: projectJsonMetadata(args),
  };
  const response = await gateway.linkedPeerFrame(installation, context, frame);
  const responseBody = response && "body" in response ? response.body : undefined;
  await cancelBinaryBody(responseBody, "Linked adapter response body is unsupported");
  if (!response || response.type !== "res" || response.id !== frame.id) {
    throw new Error("No response from linked adapter peer request");
  }
  if (!response.ok) {
    const message = response.error?.message || `Gateway error on ${call}`;
    const parsedCode = z.number().safeParse(response.error?.code);
    const code = parsedCode.success ? parsedCode.data : undefined;
    const retryable = response.error?.retryable ?? (
      code === undefined || code === 408 || code === 429 || code >= 500
    );
    if (retryable) throw new Error(message);
    return { ok: false, error: message };
  }
  const decoded = procHilResultSchema.safeParse(response.data);
  if (!decoded.success) {
    throw new Error(`Gateway returned an invalid ${call} response`);
  }
  return decoded.data;
}

/**
 * Calls the Gateway service binding and owns every body the adapter does not
 * transfer or return. A valid Gateway response accepts ownership of the
 * request body; response bodies are always cancelled because this RPC surface
 * returns structured data only.
 */
export function callAdapterGateway(
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  call: "adapter.inbound",
  args: AdapterInboundArgs,
  body?: BinaryBody,
): Promise<AdapterInboundResult>;
export function callAdapterGateway(
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  call: "adapter.state.update",
  args: AdapterStateUpdateArgs,
  body?: BinaryBody,
): Promise<AdapterStateUpdateResult>;
export async function callAdapterGateway(
  gateway: AdapterGatewayBinding,
  installation: AdapterInstallationContext,
  call: "adapter.inbound" | "adapter.state.update",
  args: AdapterInboundArgs | AdapterStateUpdateArgs,
  body?: BinaryBody,
): Promise<AdapterInboundResult | AdapterStateUpdateResult> {
  let wireArgs: JsonValue;
  try {
    wireArgs = projectJsonMetadata(args);
  } catch (error) {
    await cancelBinaryBody(body, error);
    throw error;
  }
  const frame: GatewayRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args: wireArgs,
  };
  if (body) frame.body = body;

  let response: GatewayFrame | null;
  try {
    response = await gateway.serviceFrame(installation, frame);
  } catch (error) {
    await cancelBinaryBody(body, error);
    throw error;
  }

  if (!response || response.type !== "res" || response.id !== frame.id) {
    const message = "No response from gateway serviceFrame";
    const responseBody = response && "body" in response ? response.body : undefined;
    if (responseBody !== body) {
      await cancelBinaryBody(responseBody, message);
    }
    await cancelBinaryBody(body, message);
    throw new Error(message);
  }

  // Adapters never consume a response body, so every one is cancelled; an
  // error response cancels it with the error itself. The error envelope is
  // read defensively because it crosses a service binding.
  const responseBody = "body" in response ? response.body : undefined;
  if (!response.ok) {
    const message = response.error?.message || `Gateway error on ${call}`;
    await cancelBinaryBody(responseBody, message);
    throw new Error(message);
  }
  await cancelBinaryBody(responseBody, "Gateway response body is not consumed by adapters");

  const decoded = call === "adapter.inbound"
    ? adapterInboundResultSchema.safeParse(response.data)
    : adapterStateUpdateResultSchema.safeParse(response.data);
  if (!decoded.success) {
    throw new Error(`Gateway returned an invalid ${call} response`);
  }
  return decoded.data;
}

function projectJsonMetadata(
  value:
    | AdapterInboundArgs
    | AdapterStateUpdateArgs
    | ProcHilArgs,
): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Adapter gateway request metadata is not JSON-serializable");
  }
  return jsonValueSchema.parse(JSON.parse(serialized));
}
