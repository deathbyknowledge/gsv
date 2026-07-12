import {
  DynamicWorkerExecutor,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import type { CodeModeMcpToolBinding } from "../codemode/mcp";
import type { SyscallName } from "../syscalls";
import type { CodeModeExecResult } from "../syscalls/codemode";
import { raceWithAbort } from "../shared/abort";
import {
  NET_FETCH,
  FS_DELETE,
  FS_EDIT,
  FS_READ,
  FS_SEARCH,
  FS_WRITE,
  SHELL_EXEC,
  SYS_MCP_CALL,
} from "../syscalls/constants";

export { buildCodeModeMcpToolBindings } from "../codemode/mcp";
export type { CodeModeMcpToolBinding } from "../codemode/mcp";

export const CODE_MODE_EXECUTION_TIMEOUT_MS = 60_000;

export type CodeModeExecutionOptions = {
  defaultTarget?: string;
  defaultCwd?: string;
  argv?: string[];
  args?: unknown;
  mcpToolBindings?: CodeModeMcpToolBinding[];
  signal?: AbortSignal;
};

export type CodeModeToolRequest = (
  call: SyscallName,
  args: Record<string, unknown>,
) => Promise<unknown>;

export function buildCodeModeSource(
  code: string,
  options?: CodeModeExecutionOptions,
): string {
  const userMain = buildUserMain(code);
  const defaultTarget = JSON.stringify(options?.defaultTarget ?? null);
  const defaultCwd = JSON.stringify(options?.defaultCwd ?? null);
  const argv = JSON.stringify(options?.argv ?? []);
  const args = JSON.stringify(options && "args" in options ? options.args : null);
  const mcpToolBindings = options?.mcpToolBindings ?? [];
  const mcpToolInfo = JSON.stringify(mcpToolBindings.map((binding) => ({
    functionName: binding.functionName,
    serverId: binding.serverId,
    serverName: binding.serverName,
    toolName: binding.toolName,
    description: binding.description,
    inputSchema: binding.inputSchema,
    outputSchema: binding.outputSchema,
  })));
  const mcpFunctionDeclarations = buildMcpFunctionDeclarations(mcpToolBindings);
  return `async () => {
  const argv = Object.freeze(${argv});
  const args = ${args};
  const mcpTools = Object.freeze(${mcpToolInfo});
  const __defaultTarget = ${defaultTarget};
  const __defaultCwd = ${defaultCwd};
  const __isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const __unwrapToolResult = (result) => {
    if (__isObject(result) && typeof result.__gsvCodeModeAbort === "string") {
      throw new Error(result.__gsvCodeModeAbort);
    }
    return result;
  };
  const __isAbsolutePath = (path) => path === "~" || path.startsWith("~/") || path.startsWith("/") || (
    path.length >= 3 &&
    ((path.charCodeAt(0) >= 65 && path.charCodeAt(0) <= 90) || (path.charCodeAt(0) >= 97 && path.charCodeAt(0) <= 122)) &&
    path[1] === ":" &&
    (path[2] === "/" || path[2] === "\\\\")
  );
  const __joinPath = (base, path) => {
    if (!base || __isAbsolutePath(path)) return path;
    if (base.endsWith("/")) return base + path.replace(/^\\.\\//, "");
    return base + "/" + path.replace(/^\\.\\//, "");
  };
  const __withShellDefaults = (options) => {
    const request = { ...options };
    if (!request.sessionId) {
      if (__defaultTarget !== null && request.target === undefined) request.target = __defaultTarget;
      if (__defaultCwd !== null && request.cwd === undefined) request.cwd = __defaultCwd;
    }
    return request;
  };
  const __withFsDefaults = (name, value) => {
    if (!__isObject(value)) {
      throw new Error(name + " requires an object argument");
    }
    const request = { ...value };
    if (__defaultTarget !== null && request.target === undefined) request.target = __defaultTarget;
    if (__defaultCwd !== null && typeof request.path === "string") {
      request.path = __joinPath(__defaultCwd, request.path);
    }
    return request;
  };
  const __withObjectArgs = (name, value = {}) => {
    if (!__isObject(value)) {
      throw new Error(name + " requires an object argument");
    }
    return { ...value };
  };
  const __base64FromArrayBuffer = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };
  const __arrayBufferFromBase64 = (base64) => {
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  };
  const __normalizeFetchRequest = async (input, init) => {
    const redirect = __isObject(init) && typeof init.redirect === "string"
      ? init.redirect
      : __isObject(input) && typeof input.redirect === "string"
        ? input.redirect
        : undefined;
    const request = new Request(
      input,
      redirect === "error" ? { ...init, redirect: "manual" } : init,
    );
    const method = request.method.toUpperCase();
    const bodyAllowed = method !== "GET" && method !== "HEAD";
    const normalized = {
      url: request.url,
      method,
      headers: Object.fromEntries(request.headers.entries()),
      redirect: redirect ?? request.redirect,
    };
    const target = __isObject(init) && typeof init.target === "string"
      ? init.target
      : __defaultTarget;
    if (target !== null) normalized.target = target;
    if (__isObject(init) && typeof init.timeoutMs === "number") normalized.timeoutMs = init.timeoutMs;
    if (bodyAllowed) normalized.bodyBase64 = __base64FromArrayBuffer(await request.arrayBuffer());
    return normalized;
  };
  const fetch = async (input, init) => {
    const request = await __normalizeFetchRequest(input, init);
    const response = __unwrapToolResult(await net.fetch(request));
    const proxiedResponse = new Response(
      response.bodyBase64 ? __arrayBufferFromBase64(response.bodyBase64) : null,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
    try {
      Object.defineProperty(proxiedResponse, "url", { value: response.url });
      Object.defineProperty(proxiedResponse, "redirected", { value: response.redirected === true });
    } catch {}
    return proxiedResponse;
  };
  try {
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
      writable: true,
    });
  } catch {}
  const __unwrapMcpResult = (result) => {
    result = __unwrapToolResult(result);
    if (!__isObject(result)) return result;
    if ("toolResult" in result) return result.toolResult;
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content
            .filter((item) => __isObject(item) && item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\\n")
        : "";
      throw new Error(text || "MCP tool call failed");
    }
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent;
    }
    if (Array.isArray(result.content) && result.content.length > 0 && result.content.every((item) => __isObject(item) && item.type === "text" && typeof item.text === "string")) {
      const text = result.content.map((item) => item.text).join("\\n");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  };
  const shell = async (input, options = {}) => {
    if (typeof input !== "string") {
      throw new Error("shell(input, options) requires a string input");
    }
    if (!__isObject(options)) {
      throw new Error("shell(input, options) requires options to be an object when provided");
    }
    return __unwrapToolResult(await codemode.shell({ ...__withShellDefaults(options), input }));
  };
  const fs = Object.freeze({
    read: async (args) => __unwrapToolResult(await codemode.read(__withFsDefaults("fs.read", args))),
    write: async (args) => __unwrapToolResult(await codemode.write(__withFsDefaults("fs.write", args))),
    edit: async (args) => __unwrapToolResult(await codemode.edit(__withFsDefaults("fs.edit", args))),
    delete: async (args) => __unwrapToolResult(await codemode.delete(__withFsDefaults("fs.delete", args))),
    search: async (args) => __unwrapToolResult(await codemode.search(__withFsDefaults("fs.search", args))),
  });
${mcpFunctionDeclarations}
  const __userMain = ${userMain};
  return await __userMain();
}`;
}

function buildMcpFunctionDeclarations(bindings: CodeModeMcpToolBinding[]): string {
  return bindings
    .map((binding) =>
      `  const ${binding.functionName} = async (args = {}) => __unwrapMcpResult(await __mcp.${binding.functionName}(__withObjectArgs(${JSON.stringify(binding.functionName)}, args)));`
    )
    .join("\n");
}

function sanitizeCodeModeSource(code: string): string {
  return code
    .replace(/\u0000/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function buildUserMain(code: string): string {
  const source = stripCodeFences(sanitizeCodeModeSource(code)).trim();
  if (!source) {
    return "async () => {}";
  }
  if (source.startsWith("export default ")) {
    return buildUserMain(source.slice("export default ".length));
  }
  if (looksLikeFunctionExpression(source)) {
    return source;
  }
  return `async () => {\n${source}\n}`;
}

function stripCodeFences(code: string): string {
  const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : code;
}

function looksLikeFunctionExpression(source: string): boolean {
  return /^(?:async\s+)?function(?:\s+|\()/.test(source)
    || /^(?:async\s*)?\([^)]*\)\s*=>/.test(source)
    || /^async\s+[A-Za-z_$][\w$]*\s*=>/.test(source)
    || /^[A-Za-z_$][\w$]*\s*=>/.test(source);
}

export async function executeCodeMode(
  env: Env,
  code: string,
  requestTool: CodeModeToolRequest,
  options?: CodeModeExecutionOptions,
): Promise<CodeModeExecResult> {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: CODE_MODE_EXECUTION_TIMEOUT_MS,
    globalOutbound: null,
  });
  const request = async (call: SyscallName, args: Record<string, unknown>) => {
    if (options?.signal?.aborted) {
      // Resolve the host RPC and throw in the sandbox; rejecting a late RPC is
      // reported as unhandled after the outer execution has already returned.
      return codeModeAbortResult(options.signal);
    }
    let result: unknown;
    try {
      result = await requestTool(call, args);
    } catch (error) {
      if (options?.signal?.aborted) {
        return codeModeAbortResult(options.signal);
      }
      throw error;
    }
    if (options?.signal?.aborted) {
      return codeModeAbortResult(options.signal);
    }
    return result;
  };

  const providers: ResolvedProvider[] = [
    {
      name: "codemode",
      fns: {
        shell: async (args: unknown) => request(SHELL_EXEC as SyscallName, toRecord(args, "shell")),
        read: async (args: unknown) => request(FS_READ as SyscallName, toRecord(args, "fs.read")),
        write: async (args: unknown) => request(FS_WRITE as SyscallName, toRecord(args, "fs.write")),
        edit: async (args: unknown) => request(FS_EDIT as SyscallName, toRecord(args, "fs.edit")),
        delete: async (args: unknown) => request(FS_DELETE as SyscallName, toRecord(args, "fs.delete")),
        search: async (args: unknown) => request(FS_SEARCH as SyscallName, toRecord(args, "fs.search")),
      },
    },
    {
      name: "net",
      fns: {
        fetch: async (args: unknown) => request(NET_FETCH, toRecord(args, "fetch")),
      },
    },
  ];
  const mcpToolBindings = options?.mcpToolBindings ?? [];
  if (mcpToolBindings.length > 0) {
    providers.push({
      name: "__mcp",
      fns: Object.fromEntries(mcpToolBindings.map((binding) => [
        binding.functionName,
        async (args: unknown) => request(SYS_MCP_CALL as SyscallName, {
          serverId: binding.serverId,
          name: binding.toolName,
          arguments: toOptionalRecord(args, binding.functionName),
        }),
      ])),
    });
  }

  let response;
  try {
    response = await raceWithAbort(
      executor.execute(buildCodeModeSource(code, options), providers),
      options?.signal,
    );
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const logs = response.logs && response.logs.length > 0 ? response.logs : undefined;
  if (response.error) {
    return { status: "failed", error: response.error, logs };
  }
  return { status: "completed", result: response.result, logs };
}

function codeModeAbortResult(signal: AbortSignal): Record<string, string> {
  return { __gsvCodeModeAbort: codeModeAbortMessage(signal) };
}

function codeModeAbortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : "CodeMode execution cancelled";
}

function toRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} requires an object argument`);
  }
  return value as Record<string, unknown>;
}

function toOptionalRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  return toRecord(value, name);
}
