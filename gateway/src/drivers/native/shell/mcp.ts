import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import {
  handleSysMcpAdd,
  handleSysMcpCall,
  handleSysMcpList,
  handleSysMcpRefresh,
  handleSysMcpRemove,
} from "../../../kernel/sys/mcp";
import {
  buildCodeModeMcpToolBindings,
  type CodeModeMcpToolBinding,
} from "../../../codemode/mcp";
import type {
  SysMcpCallResult,
  SysMcpServerSummary,
  SysMcpToolSummary,
  SysMcpTransportType,
} from "@humansandmachines/gsv/protocol";
import {
  SYS_MCP_ADD,
  SYS_MCP_CALL,
  SYS_MCP_LIST,
  SYS_MCP_REFRESH,
  SYS_MCP_REMOVE,
} from "../../../syscalls/constants";
import { requireCommandCapability } from "./common";
import { formatCodeModeValue } from "./codemode";

type McpAddCommand = {
  name: string;
  url: string;
  transport: SysMcpTransportType;
  callbackHost?: string;
  headers: Record<string, string>;
  json: boolean;
};

type McpServerIdCommand = {
  serverSelector: string;
  json: boolean;
};

type McpOptionalServerCommand = {
  serverSelector: string | null;
  json: boolean;
};

type McpDescribeCommand = {
  serverSelector: string;
  toolSelector: string | null;
  json: boolean;
};

type McpSearchCommand = {
  query: string;
  json: boolean;
};

type McpCallCommand = {
  serverSelector: string;
  toolSelector: string;
  args: Record<string, unknown>;
  json: boolean;
};

function parseMcpJsonOptions(args: string[]): { json: boolean } {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function parseMcpAddCommand(args: string[]): McpAddCommand {
  const options: McpAddCommand = {
    name: "",
    url: "",
    transport: "auto",
    headers: {},
    json: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--transport") {
      index += 1;
      options.transport = parseMcpTransport(requireOptionValue(args[index], current));
      continue;
    }
    if (current === "--callback-host") {
      index += 1;
      options.callbackHost = requireOptionValue(args[index], current);
      continue;
    }
    if (current === "--header") {
      index += 1;
      const { key, value } = parseKeyValue(requireOptionValue(args[index], current), "--header");
      options.headers[key] = value;
      continue;
    }
    positional.push(current);
  }

  if (positional.length !== 2) {
    throw new Error("usage: mcp add <name> <url> [--transport auto|streamable-http|sse] [--callback-host origin] [--header key=value] [--json]");
  }
  options.name = positional[0];
  options.url = positional[1];
  return options;
}

function parseMcpServerIdCommand(args: string[], command: string): McpServerIdCommand {
  const options: McpServerIdCommand = { serverSelector: "", json: false };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error(`usage: mcp ${command} <server-id> [--json]`);
  }
  options.serverSelector = positional[0];
  return options;
}

function parseMcpOptionalServerCommand(args: string[], command: string): McpOptionalServerCommand {
  const options: McpOptionalServerCommand = { serverSelector: null, json: false };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error(`usage: mcp ${command} [server-id|name] [--json]`);
  }
  options.serverSelector = positional[0] ?? null;
  return options;
}

function parseMcpDescribeCommand(args: string[]): McpDescribeCommand {
  const options: McpDescribeCommand = {
    serverSelector: "",
    toolSelector: null,
    json: false,
  };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("usage: mcp describe <server-id|name> [tool-name|codemode-function] [--json]");
  }
  options.serverSelector = positional[0];
  options.toolSelector = positional[1] ?? null;
  return options;
}

function parseMcpSearchCommand(args: string[]): McpSearchCommand {
  const options: McpSearchCommand = { query: "", json: false };
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new Error("usage: mcp search <query> [--json]");
  }
  options.query = positional.join(" ");
  return options;
}

function parseMcpCallCommand(args: string[]): McpCallCommand {
  const options: McpCallCommand = {
    serverSelector: "",
    toolSelector: "",
    args: {},
    json: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "--arg") {
      index += 1;
      const { key, value } = parseKeyValue(requireOptionValue(args[index], current), "--arg");
      options.args[key] = value;
      continue;
    }
    if (current === "--args-json") {
      index += 1;
      options.args = parseJsonObjectOption(requireOptionValue(args[index], current), "--args-json");
      continue;
    }
    positional.push(current);
  }

  if (positional.length === 1) {
    const split = splitMcpQualifiedToolSpec(positional[0]);
    if (!split) {
      throw new Error("usage: mcp call <server-id|name> <tool-name|codemode-function> [--arg key=value] [--args-json json] [--json]");
    }
    options.serverSelector = split.serverSelector;
    options.toolSelector = split.toolSelector;
    return options;
  }

  if (positional.length !== 2) {
    throw new Error("usage: mcp call <server-id|name> <tool-name|codemode-function> [--arg key=value] [--args-json json] [--json]");
  }
  options.serverSelector = positional[0];
  options.toolSelector = positional[1];
  return options;
}

function splitMcpQualifiedToolSpec(value: string): { serverSelector: string; toolSelector: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) {
    return null;
  }
  return {
    serverSelector: value.slice(0, dot),
    toolSelector: value.slice(dot + 1),
  };
}

function parseMcpTransport(value: string): SysMcpTransportType {
  if (value === "auto" || value === "streamable-http" || value === "sse") {
    return value;
  }
  throw new Error("transport must be auto, streamable-http, or sse");
}

function parseKeyValue(spec: string, option: string): { key: string; value: string } {
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error(`${option} requires key=value`);
  }
  return {
    key: spec.slice(0, eq),
    value: spec.slice(eq + 1),
  };
}

function parseJsonObjectOption(value: string, option: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${option} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function formatMcpServerList(servers: SysMcpServerSummary[]): string {
  if (servers.length === 0) {
    return "No MCP servers configured.\n";
  }
  const lines = ["SERVER_ID\tSTATE\tTOOLS\tRES\tPROMPTS\tAUTH\tNAME\tURL"];
  for (const server of servers) {
    lines.push([
      server.serverId,
      server.state,
      String(server.tools.length),
      String(server.resourceCount),
      String(server.promptCount),
      mcpAuthLabel(server),
      server.name,
      server.url,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatMcpStatus(servers: SysMcpServerSummary[]): string {
  const lines = [formatMcpServerList(servers).trimEnd()];
  const notable = servers.filter((server) => server.authUrl || server.error || server.instructions);
  if (notable.length > 0) {
    lines.push("");
    for (const server of notable) {
      lines.push(`${server.name} (${server.serverId})`);
      if (server.authUrl) {
        lines.push(`  auth_url=${server.authUrl}`);
      }
      if (server.error) {
        lines.push(`  error=${oneLine(server.error)}`);
      }
      if (server.instructions) {
        lines.push(`  instructions=${oneLine(server.instructions)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatMcpServerDetail(
  server: SysMcpServerSummary,
  aliasesByToolKey: Map<string, string[]> = new Map(),
): string {
  const lines = [
    `server_id=${server.serverId}`,
    `state=${server.state}`,
    `name=${server.name}`,
    `url=${server.url}`,
    `transport=${server.transport}`,
    `tools=${server.tools.length}`,
    `resources=${server.resourceCount}`,
    `prompts=${server.promptCount}`,
  ];
  if (server.authUrl) {
    lines.push(`auth_url=${server.authUrl}`);
  }
  if (server.error) {
    lines.push(`error=${server.error}`);
  }
  if (server.instructions) {
    lines.push(`instructions=${server.instructions}`);
  }
  if (server.tools.length > 0) {
    lines.push("", "Tools:");
    for (const tool of server.tools) {
      const aliases = aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? [];
      lines.push(`  ${tool.name}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""}`);
      if (tool.description) {
        lines.push(`    ${oneLine(tool.description)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatMcpToolList(
  servers: SysMcpServerSummary[],
  aliasesByToolKey: Map<string, string[]>,
): string {
  const lines = ["SERVER_ID\tSERVER\tSTATE\tTOOL\tCODEMODE\tREQUIRED\tDESCRIPTION"];
  for (const server of servers) {
    for (const tool of server.tools) {
      lines.push([
        server.serverId,
        server.name,
        server.state,
        tool.name,
        (aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? []).join(","),
        schemaRequiredFields(tool.inputSchema).join(","),
        tool.description ? oneLine(tool.description) : "",
      ].join("\t"));
    }
  }
  return lines.length === 1 ? "No MCP tools discovered.\n" : `${lines.join("\n")}\n`;
}

function formatMcpToolDetail(
  server: SysMcpServerSummary,
  tool: SysMcpToolSummary,
  aliasesByToolKey: Map<string, string[]>,
): string {
  const aliases = aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? [];
  const lines = [
    `server_id=${server.serverId}`,
    `server=${server.name}`,
    `state=${server.state}`,
    `tool=${tool.name}`,
    `codemode_functions=${aliases.join(",") || "-"}`,
  ];
  if (tool.description) {
    lines.push(`description=${tool.description}`);
  }
  lines.push(
    "input_schema=" + JSON.stringify(tool.inputSchema ?? {}, null, 2),
    "output_schema=" + JSON.stringify(tool.outputSchema ?? {}, null, 2),
  );
  return `${lines.join("\n")}\n`;
}

type McpSearchResult =
  | { kind: "server"; server: SysMcpServerSummary }
  | { kind: "tool"; server: SysMcpServerSummary; tool: SysMcpToolSummary; codemodeFunctions: string[] };

function searchMcpServers(
  servers: SysMcpServerSummary[],
  aliasesByToolKey: Map<string, string[]>,
  query: string,
): McpSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const results: McpSearchResult[] = [];
  for (const server of servers) {
    if ([
      server.serverId,
      server.name,
      server.url,
      server.state,
      server.error ?? "",
      server.instructions ?? "",
    ].some((value) => value.toLowerCase().includes(needle))) {
      results.push({ kind: "server", server });
    }
    for (const tool of server.tools) {
      const codemodeFunctions = aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? [];
      if ([
        tool.name,
        tool.description ?? "",
        ...codemodeFunctions,
      ].some((value) => value.toLowerCase().includes(needle))) {
        results.push({ kind: "tool", server, tool, codemodeFunctions });
      }
    }
  }
  return results;
}

function formatMcpSearchResults(results: McpSearchResult[]): string {
  if (results.length === 0) {
    return "No MCP servers or tools matched.\n";
  }
  const lines = ["KIND\tSERVER_ID\tSERVER\tSTATE\tNAME\tCODEMODE\tDESCRIPTION"];
  for (const result of results) {
    if (result.kind === "server") {
      lines.push([
        "server",
        result.server.serverId,
        result.server.name,
        result.server.state,
        result.server.name,
        "",
        result.server.url,
      ].join("\t"));
      continue;
    }
    lines.push([
      "tool",
      result.server.serverId,
      result.server.name,
      result.server.state,
      result.tool.name,
      result.codemodeFunctions.join(","),
      result.tool.description ? oneLine(result.tool.description) : "",
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatMcpCodeModeHelp(bindings: CodeModeMcpToolBinding[]): string {
  const lines = [
    "Connected MCP tools are available inside CodeMode as async functions.",
    "",
    "Discovery snippet:",
    "const servers = [...new Set(mcpTools.map((tool) => tool.serverName))];",
    "return {",
    "  servers,",
    "  tools: mcpTools.map((tool) => ({",
    "    server: tool.serverName,",
    "    functionName: tool.functionName,",
    "    toolName: tool.toolName,",
    "    description: tool.description,",
    "  })),",
    "};",
  ];
  if (bindings.length > 0) {
    lines.push("", "Ready tool functions:");
    for (const binding of bindings) {
      lines.push(`  ${binding.functionName}(args)  # ${binding.serverName}.${binding.toolName}`);
    }
  } else {
    lines.push("", "No ready MCP tool functions are currently exposed.");
  }
  return `${lines.join("\n")}\n`;
}

function formatMcpCallResult(result: SysMcpCallResult, json: boolean): ExecResult {
  if (json) {
    return {
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: result.isError ? 1 : 0,
    };
  }

  const text = textFromMcpContent(result.content);
  if (text !== null) {
    return {
      stdout: text.endsWith("\n") ? text : `${text}\n`,
      stderr: "",
      exitCode: result.isError ? 1 : 0,
    };
  }

  const value = result.structuredContent !== undefined
    ? result.structuredContent
    : result.content;
  return {
    stdout: formatCodeModeValue(value),
    stderr: "",
    exitCode: result.isError ? 1 : 0,
  };
}

function buildMcpToolBindings(servers: SysMcpServerSummary[]): CodeModeMcpToolBinding[] {
  return buildCodeModeMcpToolBindings(servers.map((server) => ({
    serverId: server.serverId,
    serverName: server.name,
    state: server.state,
    tools: server.tools,
  })));
}

function buildMcpAliasMap(bindings: CodeModeMcpToolBinding[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const binding of bindings) {
    const key = mcpToolKey(binding.serverId, binding.toolName);
    aliases.set(key, [...(aliases.get(key) ?? []), binding.functionName]);
  }
  for (const [key, names] of aliases) {
    aliases.set(key, [...names].sort((left, right) => left.localeCompare(right)));
  }
  return aliases;
}

function mcpToolKey(serverId: string, toolName: string): string {
  return `${serverId}\0${toolName}`;
}

function mcpAuthLabel(server: SysMcpServerSummary): string {
  if (server.authUrl || server.state === "authenticating") {
    return "sign-in";
  }
  if (server.error || server.state === "failed") {
    return "error";
  }
  return "-";
}

function resolveMcpServer(
  servers: SysMcpServerSummary[],
  selector: string,
): SysMcpServerSummary {
  const byId = servers.find((server) => server.serverId === selector);
  if (byId) {
    return byId;
  }
  const normalized = selector.toLowerCase();
  const matches = servers.filter((server) => server.name.toLowerCase() === normalized);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`MCP server name is ambiguous: ${selector}; use server id`);
  }
  throw new Error(`MCP server not found: ${selector}`);
}

function resolveMcpTool(
  server: SysMcpServerSummary,
  selector: string,
  aliasesByToolKey: Map<string, string[]>,
): SysMcpToolSummary {
  const direct = server.tools.find((tool) => tool.name === selector);
  if (direct) {
    return direct;
  }
  const matches = server.tools.filter((tool) =>
    (aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? []).includes(selector)
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`MCP tool selector is ambiguous: ${selector}`);
  }
  throw new Error(`MCP tool not found on ${server.name}: ${selector}`);
}

function schemaRequiredFields(schema: Record<string, unknown> | null): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string").sort((left, right) => left.localeCompare(right))
    : [];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromMcpContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      return null;
    }
    chunks.push(record.text);
  }
  return chunks.join("\n");
}

function mcpUsage(): string {
  return [
    "mcp status [--json]",
    "mcp list [--json]",
    "mcp tools [server-id|name] [--json]",
    "mcp describe <server-id|name> [tool-name|codemode-function] [--json]",
    "mcp search <query> [--json]",
    "mcp codemode [server-id|name] [--json]",
    "mcp add <name> <url> [--transport auto|streamable-http|sse] [--callback-host origin] [--header key=value] [--json]",
    "mcp refresh <server-id> [--json]",
    "mcp call <server-id|name> <tool-name|codemode-function> [--arg key=value] [--args-json json] [--json]",
    "mcp call <server-id|name>.<tool-name|codemode-function> [--arg key=value] [--args-json json] [--json]",
    "mcp remove <server-id> [--json]",
    "",
  ].join("\n");
}

export function buildMcpCommand(ctx: KernelContext) {
  return defineCommand("mcp", async (args): Promise<ExecResult> => {
    try {
      return await runMcpCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `mcp: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runMcpCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: mcpUsage(), stderr: "", exitCode: 0 };
    case "status": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const options = parseMcpJsonOptions(rest);
      const result = handleSysMcpList({}, ctx);
      return {
        stdout: options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatMcpStatus(result.servers),
        stderr: "",
        exitCode: 0,
      };
    }
    case "list": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const options = parseMcpJsonOptions(rest);
      const result = handleSysMcpList({}, ctx);
      return {
        stdout: options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatMcpServerList(result.servers),
        stderr: "",
        exitCode: 0,
      };
    }
    case "tools": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const parsed = parseMcpOptionalServerCommand(rest, "tools");
      const result = handleSysMcpList({}, ctx);
      const bindings = buildMcpToolBindings(result.servers);
      const aliasesByToolKey = buildMcpAliasMap(bindings);
      const servers = parsed.serverSelector
        ? [resolveMcpServer(result.servers, parsed.serverSelector)]
        : result.servers;
      return {
        stdout: parsed.json
          ? `${JSON.stringify({ servers, tools: bindings.filter((binding) => servers.some((server) => server.serverId === binding.serverId)) }, null, 2)}\n`
          : formatMcpToolList(servers, aliasesByToolKey),
        stderr: "",
        exitCode: 0,
      };
    }
    case "describe": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const parsed = parseMcpDescribeCommand(rest);
      const result = handleSysMcpList({}, ctx);
      const bindings = buildMcpToolBindings(result.servers);
      const aliasesByToolKey = buildMcpAliasMap(bindings);
      const server = resolveMcpServer(result.servers, parsed.serverSelector);
      if (!parsed.toolSelector) {
        return {
          stdout: parsed.json
            ? `${JSON.stringify({ server, tools: bindings.filter((binding) => binding.serverId === server.serverId) }, null, 2)}\n`
            : formatMcpServerDetail(server, aliasesByToolKey),
          stderr: "",
          exitCode: 0,
        };
      }
      const tool = resolveMcpTool(server, parsed.toolSelector, aliasesByToolKey);
      const aliases = aliasesByToolKey.get(mcpToolKey(server.serverId, tool.name)) ?? [];
      return {
        stdout: parsed.json
          ? `${JSON.stringify({ server, tool, codemodeFunctions: aliases }, null, 2)}\n`
          : formatMcpToolDetail(server, tool, aliasesByToolKey),
        stderr: "",
        exitCode: 0,
      };
    }
    case "search": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const parsed = parseMcpSearchCommand(rest);
      const result = handleSysMcpList({}, ctx);
      const aliasesByToolKey = buildMcpAliasMap(buildMcpToolBindings(result.servers));
      const matches = searchMcpServers(result.servers, aliasesByToolKey, parsed.query);
      return {
        stdout: parsed.json
          ? `${JSON.stringify({ matches }, null, 2)}\n`
          : formatMcpSearchResults(matches),
        stderr: "",
        exitCode: 0,
      };
    }
    case "codemode": {
      requireCommandCapability(ctx, SYS_MCP_LIST);
      const parsed = parseMcpOptionalServerCommand(rest, "codemode");
      const result = handleSysMcpList({}, ctx);
      const servers = parsed.serverSelector
        ? [resolveMcpServer(result.servers, parsed.serverSelector)]
        : result.servers;
      const bindings = buildMcpToolBindings(servers);
      return {
        stdout: parsed.json
          ? `${JSON.stringify({ tools: bindings }, null, 2)}\n`
          : formatMcpCodeModeHelp(bindings),
        stderr: "",
        exitCode: 0,
      };
    }
    case "add": {
      requireCommandCapability(ctx, SYS_MCP_ADD);
      const parsed = parseMcpAddCommand(rest);
      const result = await handleSysMcpAdd({
        name: parsed.name,
        url: parsed.url,
        ...(parsed.callbackHost ? { callbackHost: parsed.callbackHost } : {}),
        transport: {
          type: parsed.transport,
          ...(Object.keys(parsed.headers).length > 0 ? { headers: parsed.headers } : {}),
        },
      }, ctx);
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatMcpServerDetail(result.server),
        stderr: "",
        exitCode: 0,
      };
    }
    case "remove": {
      requireCommandCapability(ctx, SYS_MCP_REMOVE);
      const parsed = parseMcpServerIdCommand(rest, "remove");
      const list = handleSysMcpList({}, ctx);
      const server = resolveMcpServer(list.servers, parsed.serverSelector);
      const result = await handleSysMcpRemove({ serverId: server.serverId }, ctx);
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `removed=${result.removed}\n`,
        stderr: "",
        exitCode: result.removed ? 0 : 1,
      };
    }
    case "refresh": {
      requireCommandCapability(ctx, SYS_MCP_REFRESH);
      const parsed = parseMcpServerIdCommand(rest, "refresh");
      const list = handleSysMcpList({}, ctx);
      const server = resolveMcpServer(list.servers, parsed.serverSelector);
      const result = await handleSysMcpRefresh({ serverId: server.serverId }, ctx);
      const aliasesByToolKey = result.server
        ? buildMcpAliasMap(buildMcpToolBindings([result.server]))
        : new Map<string, string[]>();
      return {
        stdout: parsed.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : result.server ? formatMcpServerDetail(result.server, aliasesByToolKey) : "server=null\n",
        stderr: "",
        exitCode: result.server ? 0 : 1,
      };
    }
    case "call": {
      requireCommandCapability(ctx, SYS_MCP_CALL);
      const parsed = parseMcpCallCommand(rest);
      const list = handleSysMcpList({}, ctx);
      const bindings = buildMcpToolBindings(list.servers);
      const aliasesByToolKey = buildMcpAliasMap(bindings);
      const server = resolveMcpServer(list.servers, parsed.serverSelector);
      const tool = resolveMcpTool(server, parsed.toolSelector, aliasesByToolKey);
      const result = await handleSysMcpCall({
        serverId: server.serverId,
        name: tool.name,
        arguments: parsed.args,
      }, ctx);
      return formatMcpCallResult(result, parsed.json);
    }
    default:
      return {
        stdout: "",
        stderr: `mcp: unknown command: ${subcommand}\n${mcpUsage()}`,
        exitCode: 1,
      };
  }
}
