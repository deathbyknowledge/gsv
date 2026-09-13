import { env } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type { Kernel } from "../kernel/do";
import {
  parseInstallationId,
} from "./identity";
import type { GatewayEnv } from "../runtime-env";

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
    throw new Error("Process Durable Object name is invalid");
  }

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

function parseProcessId(value: string): string {
  if (value.length === 0)
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
    throw new Error("Conversation Durable Object name is invalid");
  }
  const separator = name.indexOf(":", CONVERSATION_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1) {
    throw new Error("Conversation Durable Object name is invalid");
  }
  try {
    const installationId = parseInstallationId(decodeURIComponent(
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

function parseConversationId(value: string): string {
  if (value.length === 0) {
    throw new Error("conversationId must be a non-empty string");
  }
  return value;
}

function assertDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Durable Object name is too long");
  }
}

export async function resolveInstallationRoute(
  request: Request,
  options: { allowProvisioning?: boolean } = {},
) {
  const hostname = new URL(request.url).hostname;
  // SAFETY: Deployment binds the trusted directory RPC contract described by GatewayEnv.
  const directory = (env as Env & GatewayEnv).INSTALLATION_DIRECTORY;
  if (!directory) throw new Error("Installation directory is not configured");
  const result = await directory.resolveHostname(hostname);
  if (!result.found || !isRoutableManagedInstallationState(
    result.state,
    options.allowProvisioning ?? false,
  )) {
    return null;
  }

  let installationId: string;
  try {
    installationId = parseInstallationId(result.installationId);
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
  return namespace.getByName(parseInstallationId(installationId));
}

// TODO: this should move to wherever we put an actual implementation for it
export type { InstallationDirectoryResult, InstallationDirectoryService };
