import {
  jsonSchemaToType,
  sanitizeToolName,
} from "@cloudflare/codemode";

type JsonSchema = Parameters<typeof jsonSchemaToType>[0];

export type CodeModeMcpToolSource = {
  serverId: string;
  serverName?: string;
  name?: string;
  state: string;
  tools: CodeModeMcpToolSourceTool[];
};

export type CodeModeMcpToolSourceTool = {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
};

export type CodeModeMcpToolBinding = {
  functionName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
};

const DEFAULT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
};

const RESERVED_MCP_FUNCTION_NAMES = new Set([
  "args",
  "argv",
  "codemode",
  "fetch",
  "fs",
  "mcpTools",
  "net",
  "shell",
  "__arrayBufferFromBase64",
  "__base64FromArrayBuffer",
  "__defaultCwd",
  "__defaultTarget",
  "__fetchRedirectMode",
  "__isAbsolutePath",
  "__isObject",
  "__joinPath",
  "__mcp",
  "__normalizeFetchRequest",
  "__unwrapMcpResult",
  "__userMain",
  "__withFsDefaults",
  "__withObjectArgs",
  "__withShellDefaults",
]);

export function buildCodeModeMcpToolBindings(
  servers: CodeModeMcpToolSource[],
): CodeModeMcpToolBinding[] {
  const candidates = servers
    .filter((server) => server.state === "ready")
    .flatMap((server) => server.tools.map((tool) => ({
      serverId: server.serverId,
      serverName: sourceServerName(server),
      toolName: tool.name,
      toolBase: normalizedToolFunctionName(tool.name),
      qualifiedBase: normalizedToolFunctionName(`${sourceServerName(server)}_${tool.name}`),
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
    })));
  const byToolBase = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    byToolBase.set(candidate.toolBase, [
      ...(byToolBase.get(candidate.toolBase) ?? []),
      candidate,
    ]);
  }

  const used = new Set(RESERVED_MCP_FUNCTION_NAMES);
  const bindings: CodeModeMcpToolBinding[] = [];
  const addBinding = (
    functionName: string,
    candidate: typeof candidates[number],
  ) => {
    if (used.has(functionName)) {
      return false;
    }
    used.add(functionName);
    bindings.push({
      functionName,
      serverId: candidate.serverId,
      serverName: candidate.serverName,
      toolName: candidate.toolName,
      description: candidate.description,
      inputSchema: candidate.inputSchema,
      outputSchema: candidate.outputSchema,
    });
    return true;
  };

  for (const candidate of candidates) {
    if ((byToolBase.get(candidate.toolBase)?.length ?? 0) === 1) {
      addBinding(candidate.toolBase, candidate);
    }
  }
  for (const candidate of candidates) {
    const existingForTool = bindings.some((binding) =>
      binding.serverId === candidate.serverId
      && binding.toolName === candidate.toolName
      && binding.functionName === candidate.qualifiedBase
    );
    if (existingForTool) {
      continue;
    }
    const qualified = uniqueMcpFunctionName(candidate.qualifiedBase, candidate, used);
    addBinding(qualified, candidate);
  }

  return bindings;
}

export function buildCodeModeMcpTypeDeclarations(
  bindings: CodeModeMcpToolBinding[],
): string {
  if (bindings.length === 0) {
    return "";
  }

  const usedTypeNames = new Set<string>();
  const typeBlocks: string[] = [];
  const functionBlocks: string[] = [];

  for (const binding of bindings) {
    const typeBase = uniqueTypeBase(binding.functionName, usedTypeNames);
    const inputTypeName = `${typeBase}Input`;
    const outputTypeName = `${typeBase}Output`;
    const inputParameter = hasRequiredProperties(binding.inputSchema)
      ? `input: ${inputTypeName}`
      : `input?: ${inputTypeName}`;

    typeBlocks.push(schemaTypeDeclaration(
      binding.inputSchema ?? DEFAULT_INPUT_SCHEMA,
      inputTypeName,
      "Record<string, unknown>",
    ));
    typeBlocks.push(
      binding.outputSchema
        ? schemaTypeDeclaration(binding.outputSchema, outputTypeName, "unknown")
        : `type ${outputTypeName} = unknown;`,
    );

    functionBlocks.push([
      "/**",
      ` * ${escapeJsDoc(`${binding.serverName}.${binding.toolName}`)}`,
      ...(binding.description ? [` * ${escapeJsDoc(oneLine(binding.description))}`] : []),
      " */",
      `declare function ${binding.functionName}(${inputParameter}): Promise<${outputTypeName}>;`,
    ].join("\n"));
  }

  return [
    ...typeBlocks,
    "",
    ...functionBlocks,
  ].join("\n");
}

function normalizedToolFunctionName(value: string): string {
  const sanitized = sanitizeToolName(value);
  return sanitized && sanitized !== "_" ? sanitized : "tool";
}

function sourceServerName(server: CodeModeMcpToolSource): string {
  return server.serverName ?? server.name ?? server.serverId;
}

function uniqueMcpFunctionName(
  base: string,
  candidate: { serverId: string; toolName: string },
  used: Set<string>,
): string {
  if (!used.has(base)) {
    return base;
  }
  return `${base}_${shortHash(`${candidate.serverId}:${candidate.toolName}`)}`;
}

function schemaTypeDeclaration(
  schema: Record<string, unknown>,
  typeName: string,
  fallback: string,
): string {
  try {
    return ensureSemicolon(jsonSchemaToType(schema as JsonSchema, typeName).trim());
  } catch {
    return `type ${typeName} = ${fallback};`;
  }
}

function uniqueTypeBase(functionName: string, used: Set<string>): string {
  const base = toPascalTypeName(functionName);
  let candidate = base;
  let suffix = 2;
  while (used.has(`${candidate}Input`) || used.has(`${candidate}Output`)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(`${candidate}Input`);
  used.add(`${candidate}Output`);
  return candidate;
}

function toPascalTypeName(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
  if (!joined) {
    return "McpTool";
  }
  return /^[0-9]/.test(joined) ? `Mcp${joined}` : joined;
}

function ensureSemicolon(value: string): string {
  return /[;}]$/.test(value) ? value : `${value};`;
}

function hasRequiredProperties(schema: Record<string, unknown> | null): boolean {
  return Array.isArray(schema?.required) && schema.required.length > 0;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeJsDoc(value: string): string {
  return value.replace(/\*\//g, "* /");
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
