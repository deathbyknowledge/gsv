import { getAgentByName } from "agents";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import type { Kernel } from "../kernel/do";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationIdentity,
  parseInstallationId,
  type InstallationId,
  type InstallationIdentity,
  type InstallationIdentityInput,
} from "./identity";
import { getGatewayDeployment } from "./deployment";

export function processDurableObjectName(
  installationId: InstallationId | string,
  pid: string,
): string {
  const parsed = parseInstallationId(installationId);
  if (parsed === LEGACY_STANDALONE_INSTALLATION_ID) {
    return pid;
  }
  return `process:${encodeURIComponent(parsed)}:${encodeURIComponent(pid)}`;
}

export type { InstallationDirectoryResult, InstallationDirectoryService };

const ROUTABLE_MANAGED_INSTALLATION_STATES: ReadonlySet<ManagedInstallationState> = new Set([
  "trialing",
  "active",
  "past_due",
  "restricted",
  "cancelled",
  "retained",
]);

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

export type InstallationRouteOptions = {
  allowProvisioning?: boolean;
};

export function getStandaloneServiceInstallationId(env: Env): InstallationId | null {
  const deployment = getGatewayDeployment(env);
  return deployment.kind === "standalone" ? deployment.installationId : null;
}

export function getGatewayInstallationRoutingSource(
  request: Request,
  env: Env,
): InstallationRoutingSource {
  const deployment = getGatewayDeployment(env);
  if (deployment.kind === "managed") {
    return {
      kind: "managed",
      directory: deployment.directory,
    };
  }

  return {
    kind: "standalone",
    identity: parseInstallationIdentity({
      installationId: deployment.installationId,
      handle: deployment.handle,
      canonicalOrigin: deployment.canonicalOrigin ?? new URL(request.url).origin,
    }),
  };
}

export async function resolveInstallationRoute(
  request: Request,
  source: InstallationRoutingSource,
  options: InstallationRouteOptions = {},
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
  if (
    !result.found
    || (
      !ROUTABLE_MANAGED_INSTALLATION_STATES.has(result.state)
      && !(options.allowProvisioning && result.state === "provisioning")
    )
  ) {
    return null;
  }

  const identity = parseInstallationIdentity(result);
  if (identity.installationId === LEGACY_STANDALONE_INSTALLATION_ID) {
    return null;
  }

  return {
    source: source.kind,
    requestedHostname,
    identity,
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
