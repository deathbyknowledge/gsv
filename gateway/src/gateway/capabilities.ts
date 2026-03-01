import {
  CAPABILITY_IDS,
  type CapabilityId,
  type NodeRuntimeInfo,
  type ToolDefinition,
} from "../protocol/tools";

const CAPABILITY_SET = new Set<CapabilityId>(CAPABILITY_IDS);

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

  return {
    hostCapabilities,
    toolCapabilities,
  };
}
