import {
  CAPABILITY_IDS,
  HOST_ROLES,
  type CapabilityId,
  type HostRole,
  type NodeRuntimeInfo,
  type ToolDefinition,
} from "../protocol/tools";

const CAPABILITY_SET = new Set<CapabilityId>(CAPABILITY_IDS);
const HOST_ROLE_SET = new Set<HostRole>(HOST_ROLES);

export const EXECUTION_BASELINE_CAPABILITIES: CapabilityId[] = [
  "filesystem.list",
  "filesystem.read",
  "filesystem.write",
  "shell.exec",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCapabilityList(
  value: unknown,
  fieldPath: string,
): CapabilityId[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array`);
  }

  const normalized = new Set<CapabilityId>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${fieldPath} must contain only strings`);
    }

    const capability = item.trim() as CapabilityId;
    if (!CAPABILITY_SET.has(capability)) {
      throw new Error(`${fieldPath} contains unknown capability: ${item}`);
    }

    normalized.add(capability);
  }

  if (normalized.size === 0) {
    throw new Error(`${fieldPath} must not be empty`);
  }

  return Array.from(normalized).sort();
}

export function validateNodeRuntimeInfo(params: {
  nodeId: string;
  tools: ToolDefinition[];
  runtime: unknown;
}): NodeRuntimeInfo {
  const runtimePrefix = `nodeRuntime for ${params.nodeId}`;
  if (!isRecord(params.runtime)) {
    throw new Error(`${runtimePrefix} is required`);
  }

  const roleRaw = params.runtime.hostRole;
  if (typeof roleRaw !== "string") {
    throw new Error(`${runtimePrefix}.hostRole is required`);
  }

  const hostRole = roleRaw.trim() as HostRole;
  if (!HOST_ROLE_SET.has(hostRole)) {
    throw new Error(
      `${runtimePrefix}.hostRole must be one of: ${HOST_ROLES.join(", ")}`,
    );
  }

  const hostCapabilities = normalizeCapabilityList(
    params.runtime.hostCapabilities,
    `${runtimePrefix}.hostCapabilities`,
  );

  const toolCapabilitiesRaw = params.runtime.toolCapabilities;
  if (!isRecord(toolCapabilitiesRaw)) {
    throw new Error(`${runtimePrefix}.toolCapabilities must be an object`);
  }

  const seenToolNames = new Set<string>();
  for (const tool of params.tools) {
    if (seenToolNames.has(tool.name)) {
      throw new Error(`Duplicate tool name in node ${params.nodeId}: ${tool.name}`);
    }
    seenToolNames.add(tool.name);
  }

  const toolCapabilities: Record<string, CapabilityId[]> = {};
  for (const tool of params.tools) {
    if (!(tool.name in toolCapabilitiesRaw)) {
      throw new Error(
        `${runtimePrefix}.toolCapabilities missing entry for tool: ${tool.name}`,
      );
    }

    const normalized = normalizeCapabilityList(
      toolCapabilitiesRaw[tool.name],
      `${runtimePrefix}.toolCapabilities.${tool.name}`,
    );

    for (const capability of normalized) {
      if (!hostCapabilities.includes(capability)) {
        throw new Error(
          `${runtimePrefix}.toolCapabilities.${tool.name} includes ${capability}, which is missing from hostCapabilities`,
        );
      }
    }

    toolCapabilities[tool.name] = normalized;
  }

  for (const extraTool of Object.keys(toolCapabilitiesRaw)) {
    if (!seenToolNames.has(extraTool)) {
      throw new Error(
        `${runtimePrefix}.toolCapabilities has unknown tool key: ${extraTool}`,
      );
    }
  }

  if (hostRole === "execution") {
    const missing = EXECUTION_BASELINE_CAPABILITIES.filter(
      (capability) => !hostCapabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new Error(
        `${runtimePrefix}.hostCapabilities missing execution baseline: ${missing.join(", ")}`,
      );
    }
  }

  return {
    hostRole,
    hostCapabilities,
    toolCapabilities,
  };
}

export function pickExecutionHostId(params: {
  nodeIds: string[];
  runtimes: Record<string, NodeRuntimeInfo>;
}): string | null {
  const executionHosts = params.nodeIds
    .filter((nodeId) => params.runtimes[nodeId]?.hostRole === "execution")
    .sort();

  return executionHosts[0] ?? null;
}

export function listHostsByRole(params: {
  nodeIds: string[];
  runtimes: Record<string, NodeRuntimeInfo>;
  role: HostRole;
}): string[] {
  return params.nodeIds
    .filter((nodeId) => params.runtimes[nodeId]?.hostRole === params.role)
    .sort();
}
