import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import type { Kernel } from "../kernel/do";
import {
  SINGLETON_INSTALLATION_ID,
  parseInstallationId,
  parseManagedInstallationId,
} from "./identity";

const PROCESS_DURABLE_OBJECT_PREFIX = "process:";
const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;

export type ProcessDurableObjectIdentity = {
  installationId: string;
  pid: string;
};

export function processDurableObjectName(
  installationId: string,
  pid: string,
): string {
  const parsedInstallationId = parseInstallationId(installationId);
  const parsedPid = parseProcessId(pid);
  const name = `${PROCESS_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsedInstallationId)}:${encodeURIComponent(parsedPid)}`;
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Process Durable Object name is too long");
  }
  return name;
}

export function parseProcessDurableObjectName(
  name: string | undefined,
): ProcessDurableObjectIdentity {
  if (!name)
    throw new Error("Process Durable Objects must be accessed by name");

  if (!name.startsWith(PROCESS_DURABLE_OBJECT_PREFIX)) 
    throw new Error("Process Durable Object name is invalid");

  const separator = name.indexOf(":", PROCESS_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1) 
    throw new Error("Process Durable Object name is invalid");

  try {
    const installationId = parseInstallationId(decodeURIComponent(
      name.slice(PROCESS_DURABLE_OBJECT_PREFIX.length, separator),
    ));
    const pid = parseProcessId(decodeURIComponent(name.slice(separator + 1)));
    if (processDurableObjectName(installationId, pid) !== name) 
      throw new Error("Process Durable Object name is not canonical");

    return { installationId, pid };
  } catch (error) {
    if (error instanceof Error && error.message === "Process Durable Object name is not canonical") {
      throw error;
    }
    throw new Error("Process Durable Object name is invalid");
  }
}

function parseProcessId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) 
    throw new Error("pid must be a non-empty string");
  return value;
}

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

  let installationId: string;
  try {
    installationId = parseManagedInstallationId(result.installationId);
  } catch {
    return null;
  }

  return {
    identity: {
      installationId,
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
