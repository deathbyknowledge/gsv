import type { AdapterGatewayInterface } from "../../../packages/gsv/src/protocol/adapters.js";
import { adapterInboundResultSchema } from "../../../packages/gsv/src/protocol/adapters.js";
import type {
  AdapterInboundArgs,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
} from "../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { adapterStateUpdateResultSchema } from "../../../packages/gsv/src/protocol/syscalls/adapter.js";
import { cancelBinaryBody } from "./media-body";
import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "./installation";
import type {
  AdapterInstallationContext,
  AdapterInboundResult,
  BinaryBody,
  GatewayFrame,
  GatewayRequestFrame,
} from "./types";

export type AdapterGatewayBinding = AdapterGatewayInterface<GatewayFrame>;

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
  const frame: GatewayRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  };
  if (body) frame.body = body;

  let response: GatewayFrame | null;
  try {
    response = installation.installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
      ? await gateway.serviceFrame(frame)
      : await gateway.serviceFrame(installation, frame);
  } catch (error) {
    await cancelBinaryBody(body, error);
    throw error;
  }

  if (!response || response.type !== "res") {
    const message = "No response from gateway serviceFrame";
    if (response?.body !== body) {
      await cancelBinaryBody(response?.body, message);
    }
    await cancelBinaryBody(body, message);
    throw new Error(message);
  }

  const errorMessage = response.ok
    ? null
    : response.error?.message || `Gateway error on ${call}`;
  await cancelBinaryBody(
    response.body,
    errorMessage ?? "Gateway response body is not consumed by adapters",
  );
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const decoded = call === "adapter.inbound"
    ? adapterInboundResultSchema.safeParse(response.data)
    : adapterStateUpdateResultSchema.safeParse(response.data);
  if (!decoded.success) {
    throw new Error(`Gateway returned an invalid ${call} response`);
  }
  return decoded.data;
}
