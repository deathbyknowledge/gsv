import { getAgentByName } from "agents";
import type { Kernel } from "../kernel/do";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationIdentity,
  parseInstallationId,
  type InstallationId,
  type InstallationIdentity,
  type InstallationIdentityInput,
} from "./identity";

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

export type InstallationRoutingSource =
  | {
      kind: "managed";
      directory: InstallationDirectoryService;
    }
  | {
      kind: "standalone";
      identity: InstallationIdentity;
    };

export type TrustedInstallationRoute = {
  source: InstallationRoutingSource["kind"];
  requestedHostname: string;
  identity: InstallationIdentity;
};

type GatewayInstallationBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService;
  GSV_INSTALLATION_ID?: string;
  GSV_INSTALLATION_HANDLE?: string;
  GSV_CANONICAL_ORIGIN?: string;
};

export function getStandaloneServiceInstallationId(env: Env): InstallationId | null {
  const bindings = env as Env & GatewayInstallationBindings;
  if (bindings.INSTALLATION_DIRECTORY) {
    return null;
  }
  return parseInstallationId(
    bindings.GSV_INSTALLATION_ID ?? LEGACY_STANDALONE_INSTALLATION_ID,
  );
}

export function getGatewayInstallationRoutingSource(
  request: Request,
  env: Env,
): InstallationRoutingSource {
  const bindings = env as Env & GatewayInstallationBindings;
  if (bindings.INSTALLATION_DIRECTORY) {
    return {
      kind: "managed",
      directory: bindings.INSTALLATION_DIRECTORY,
    };
  }

  return {
    kind: "standalone",
    identity: parseInstallationIdentity({
      installationId: bindings.GSV_INSTALLATION_ID ?? LEGACY_STANDALONE_INSTALLATION_ID,
      handle: bindings.GSV_INSTALLATION_HANDLE ?? "gsv",
      canonicalOrigin: bindings.GSV_CANONICAL_ORIGIN ?? new URL(request.url).origin,
    }),
  };
}

export async function resolveInstallationRoute(
  request: Request,
  source: InstallationRoutingSource,
): Promise<TrustedInstallationRoute | null> {
  const requestedHostname = normalizeHostname(new URL(request.url).hostname);
  if (source.kind === "standalone") {
    return {
      source: source.kind,
      requestedHostname,
      identity: source.identity,
    };
  }

  const result = await source.directory.resolveHostname(requestedHostname);
  if (!result.found || result.state !== "active") {
    return null;
  }

  return {
    source: source.kind,
    requestedHostname,
    identity: parseInstallationIdentity(result),
  };
}

export async function resolveInstallationTarget<T>(
  request: Request,
  source: InstallationRoutingSource,
  open: (installationId: InstallationId) => Promise<T>,
): Promise<{ route: TrustedInstallationRoute; target: T } | null> {
  const route = await resolveInstallationRoute(request, source);
  if (!route) {
    return null;
  }

  return {
    route,
    target: await open(route.identity.installationId),
  };
}

export async function getKernelByInstallationId(
  namespace: DurableObjectNamespace<Kernel>,
  installationId: InstallationId | string,
): Promise<DurableObjectStub<Kernel>> {
  return await getAgentByName(namespace, parseInstallationId(installationId));
}

export function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) {
    throw new Error("hostname is invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw new Error("hostname is invalid");
  }
  if (parsed.hostname !== normalized || parsed.port || parsed.username || parsed.password) {
    throw new Error("hostname is invalid");
  }
  return normalized;
}

export function installationIdentityInput(identity: InstallationIdentity): InstallationIdentityInput {
  return {
    installationId: identity.installationId,
    handle: identity.handle,
    canonicalOrigin: identity.canonicalOrigin,
  };
}
