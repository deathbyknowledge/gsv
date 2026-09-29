import {
  emitTelemetry,
  integrationProviderFromName,
  integrationProviderFromUrl,
  type IntegrationKind,
  type IntegrationProvider,
  type TelemetryEnvironment,
} from "@humansandmachines/gsv/telemetry";
import type { OAuthConnectionKind } from "./oauth-store";

export type IntegrationTelemetryScope = {
  env: TelemetryEnvironment | undefined;
  installationId: string;
};

export type IntegrationConnectedInput =
  | { kind: "mcp"; url: string }
  | { kind: OAuthConnectionKind; provider: string };

/**
 * Report a first-time integration connection on the product stream. Callers
 * invoke this only after the durable record exists and only when no matching
 * record existed before, so re-authorization never counts as a connection.
 * Records carry two closed enums and nothing from the caller's input.
 */
export function emitIntegrationConnected(
  scope: IntegrationTelemetryScope,
  input: IntegrationConnectedInput,
): boolean {
  let integrationKind: IntegrationKind;
  let provider: IntegrationProvider;
  if (input.kind === "mcp") {
    integrationKind = "mcp";
    provider = integrationProviderFromUrl(input.url);
  } else if (input.kind === "mcp-server") {
    // The OAuth leg of an MCP server; sys.mcp.add already reported the server.
    return false;
  } else {
    integrationKind = input.kind;
    provider = integrationProviderFromName(input.provider);
  }
  return emitTelemetry(scope.env, {
    installationId: scope.installationId,
    component: "gateway",
    event: {
      stream: "product",
      name: "integration.connected",
      properties: { integrationKind, provider },
    },
  });
}
