import type { AdapterGatewayInterface } from "../../../packages/gsv/src/protocol/adapters.js";
import { cancelBinaryBody } from "./media-body";
import type {
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
export async function callAdapterGateway<T = unknown>(
  gateway: AdapterGatewayBinding,
  call: string,
  args: unknown,
  body?: BinaryBody,
): Promise<T> {
  const frame: GatewayRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
    ...(body ? { body } : {}),
  };

  let response: GatewayFrame | null;
  try {
    response = await gateway.serviceFrame(frame);
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

  return (response.data ?? {}) as T;
}
