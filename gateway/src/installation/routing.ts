import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import type { Kernel } from "../kernel/do";
import {
  SINGLETON_INSTALLATION_ID,
  parseInstallationId,
} from "./identity";

function getGatewayInstallationRoutingSource(
  request: Request,
) {
  const bindings = env as Env & GatewayInstallationBindings;
  if (bindings.INSTALLATION_DIRECTORY) {
    return {
      kind: "multi" as const,
      directory: bindings.INSTALLATION_DIRECTORY,
    };
  }

  return {
    kind: "single" as const,
    identity: {
      installationId: SINGLETON_INSTALLATION_ID,
      canonicalOrigin: bindings.GSV_CANONICAL_ORIGIN ?? new URL(request.url).origin,
    },
  };
}

export async function resolveInstallationRoute(
  request: Request,
) {
  const hostname = new URL(request.url).hostname;
  const source = getGatewayInstallationRoutingSource(request);
  if (source.kind === "single") {
    return {
      identity: source.identity,
    };
  }

  const result = await source.directory.resolveHostname(hostname);
  if (!result.found || result.state !== "active") {
    return null;
  }

  return {
    identity: {
      installationId: result.installationId,
      canonicalOrigin: result.canonicalOrigin,
      handle: result.handle,
    },
  };
}

export async function getKernelByInstallationId(
  namespace: DurableObjectNamespace<Kernel>,
  installationId: string,
): Promise<DurableObjectStub<Kernel>> {
  return await getAgentByName(namespace, parseInstallationId(installationId));
}

// TODO: this should move to wherever we put an actual implementation for it
export type InstallationDirectoryResult =
  | {
      found: true;
      installationId: string;
      handle: string;
      canonicalOrigin: string;
      state: string;
    }
  | { found: false };

export interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<InstallationDirectoryResult>;
}

export type GatewayInstallationBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService;
  GSV_CANONICAL_ORIGIN?: string;
};
