import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  InstallationOnboardingService,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import type { Kernel } from "../kernel/do";
import {
  SINGLETON_INSTALLATION_ID,
  parseInstallationId,
  parseManagedInstallationId,
} from "./identity";

const PROCESS_DURABLE_OBJECT_PREFIX = "process:";
const CONVERSATION_DURABLE_OBJECT_PREFIX = "conversation:";
const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;

export type ProcessDurableObjectIdentity = {
  installationId: string;
  pid: string;
};

export type ConversationDurableObjectIdentity = {
  installationId: string;
  conversationId: string;
};

export function processDurableObjectName(
  installationId: string,
  pid: string,
): string {
  const parsedInstallationId = parseInstallationId(installationId);
  const parsedPid = parseProcessId(pid);
  if (parsedInstallationId === SINGLETON_INSTALLATION_ID) {
    if (parsedPid.startsWith(PROCESS_DURABLE_OBJECT_PREFIX)) {
      throw new Error("Standalone pid conflicts with managed Process addressing");
    }
    assertProcessDurableObjectNameLength(parsedPid);
    return parsedPid;
  }
  const name = `${PROCESS_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsedInstallationId)}:${encodeURIComponent(parsedPid)}`;
  assertProcessDurableObjectNameLength(name);
  return name;
}

export function parseProcessDurableObjectName(
  name: string | undefined,
): ProcessDurableObjectIdentity {
  if (!name)
    throw new Error("Process Durable Objects must be accessed by name");

  if (!name.startsWith(PROCESS_DURABLE_OBJECT_PREFIX)) {
    const pid = parseProcessId(name);
    assertProcessDurableObjectNameLength(name);
    return { installationId: SINGLETON_INSTALLATION_ID, pid };
  }

  const separator = name.indexOf(":", PROCESS_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1)
    throw new Error("Process Durable Object name is invalid");

  try {
    const installationId = parseManagedInstallationId(decodeURIComponent(
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

function assertProcessDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Process Durable Object name is too long");
  }
}

export function conversationDurableObjectName(
  installationId: string,
  conversationId: string,
): string {
  const parsedInstallationId = parseInstallationId(installationId);
  const parsedConversationId = parseConversationId(conversationId);
  if (parsedInstallationId === SINGLETON_INSTALLATION_ID) {
    if (parsedConversationId.startsWith(CONVERSATION_DURABLE_OBJECT_PREFIX)) {
      throw new Error("Standalone conversation id conflicts with managed Conversation addressing");
    }
    assertDurableObjectNameLength(parsedConversationId);
    return parsedConversationId;
  }
  const name = `${CONVERSATION_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsedInstallationId)}:${encodeURIComponent(parsedConversationId)}`;
  assertDurableObjectNameLength(name);
  return name;
}

export function parseConversationDurableObjectName(
  name: string | undefined,
): ConversationDurableObjectIdentity {
  if (!name) {
    throw new Error("Conversation Durable Objects must be accessed by name");
  }
  if (!name.startsWith(CONVERSATION_DURABLE_OBJECT_PREFIX)) {
    const conversationId = parseConversationId(name);
    assertDurableObjectNameLength(name);
    return { installationId: SINGLETON_INSTALLATION_ID, conversationId };
  }
  const separator = name.indexOf(":", CONVERSATION_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1) {
    throw new Error("Conversation Durable Object name is invalid");
  }
  try {
    const installationId = parseManagedInstallationId(decodeURIComponent(
      name.slice(CONVERSATION_DURABLE_OBJECT_PREFIX.length, separator),
    ));
    const conversationId = parseConversationId(decodeURIComponent(name.slice(separator + 1)));
    if (conversationDurableObjectName(installationId, conversationId) !== name) {
      throw new Error("Conversation Durable Object name is not canonical");
    }
    return { installationId, conversationId };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "Conversation Durable Object name is not canonical"
    ) {
      throw error;
    }
    throw new Error("Conversation Durable Object name is invalid");
  }
}

function parseConversationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("conversationId must be a non-empty string");
  }
  return value;
}

function assertDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Durable Object name is too long");
  }
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
  options: { allowProvisioning?: boolean } = {},
) {
  const hostname = new URL(request.url).hostname;
  const source = getGatewayInstallationRoutingSource(request);
  if (source.kind === "single") {
    return {
      identity: source.identity,
    };
  }

  const result = await source.directory.resolveHostname(hostname);
  if (!result.found || !isRoutableManagedInstallationState(
    result.state,
    options.allowProvisioning ?? false,
  )) {
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

export function isRoutableManagedInstallationState(
  state: ManagedInstallationState,
  allowProvisioning: boolean,
): boolean {
  return state === "active" || (allowProvisioning && state === "provisioning");
}

export async function getKernelByInstallationId(
  namespace: DurableObjectNamespace<Kernel>,
  installationId: string,
): Promise<DurableObjectStub<Kernel>> {
  return await getAgentByName(namespace, parseInstallationId(installationId));
}

// TODO: this should move to wherever we put an actual implementation for it
export type { InstallationDirectoryResult, InstallationDirectoryService };

export type GatewayInstallationBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService & InstallationOnboardingService;
  MANAGED_MAIL_OUTBOUND?: Queue<import("@humansandmachines/gsv/protocol").ManagedOutboundMailCommand>;
  GSV_CANONICAL_ORIGIN?: string;
};
