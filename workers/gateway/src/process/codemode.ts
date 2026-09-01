import {
  DynamicWorkerExecutor,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import { z } from "zod";
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
  MAIL_SEND,
  SHELL_EXEC,
  SYS_MCP_CALL,
} from "../syscalls/constants";
import {
  CODE_MODE_UNAVAILABLE_ERROR,
  type CodeModeEnvironment,
} from "../codemode/availability";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";

export { buildCodeModeMcpToolBindings } from "../codemode/mcp";
export type { CodeModeMcpToolBinding } from "../codemode/mcp";

export const CODE_MODE_EXECUTION_TIMEOUT_MS = 60_000;

export type CodeModeExecutionOptions = {
  defaultTarget?: string;
  defaultCwd?: string;
  argv?: string[];
  args?: unknown;
  mailDeliveryBase?: string;
  mcpToolBindings?: CodeModeMcpToolBinding[];
  signal?: AbortSignal;
};

export type CodeModeToolRequest = (
  call: SyscallName,
  args: JsonObject,
) => Promise<JsonValue>;

const codeModeMailArgsSchema = z.intersection(
  jsonObjectSchema,
  z.object({ deliveryId: z.string().trim().min(1) }),
);
const optionalCodeModeArgsSchema = z.nullish(jsonObjectSchema).transform((value) => value ?? {});

export function buildCodeModeSource(
  code: string,
  options?: CodeModeExecutionOptions,
): string {
  const userMain = buildUserMain(code);
  const defaultTarget = JSON.stringify(options?.defaultTarget ?? null);
  const defaultCwd = JSON.stringify(options?.defaultCwd ?? null);
  const argv = JSON.stringify(options?.argv ?? []);
  const args = JSON.stringify(options && "args" in options ? options.args : null);
  const mailDeliveryBase = JSON.stringify(options?.mailDeliveryBase ?? null);
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
  const __mailDeliveryBase = ${mailDeliveryBase};
  let __mailDeliveryOrdinal = 0;
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
  const mail = Object.freeze({
    send: async (args) => {
      const request = __withObjectArgs("mail.send", args);
      __mailDeliveryOrdinal += 1;
      if (
        request.deliveryId !== undefined
        && (typeof request.deliveryId !== "string" || request.deliveryId.trim().length === 0)
      ) {
        throw new Error("mail.send deliveryId must be a string");
      }
      if (request.deliveryId === undefined) {
        if (__mailDeliveryBase === null) {
          throw new Error("mail.send requires deliveryId in this CodeMode execution");
        }
        request.deliveryId = __mailDeliveryBase + ":" + __mailDeliveryOrdinal;
      }
      return __unwrapToolResult(await __mail.send(request));
    },
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
    .replaceAll(String.fromCharCode(0), "")
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
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
  env: CodeModeEnvironment,
  code: string,
  requestTool: CodeModeToolRequest,
  options?: CodeModeExecutionOptions,
): Promise<CodeModeExecResult> {
  if (!env.LOADER) {
    return {
      status: "failed",
      error: CODE_MODE_UNAVAILABLE_ERROR,
    };
  }
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: CODE_MODE_EXECUTION_TIMEOUT_MS,
    globalOutbound: null,
  });
  const request = async (call: SyscallName, args: JsonObject) => {
    if (options?.signal?.aborted) {
      // Resolve the host RPC and throw in the sandbox; rejecting a late RPC is
      // reported as unhandled after the outer execution has already returned.
      return codeModeAbortResult(options.signal);
    }
    let result: JsonValue;
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
        shell: async (args) => request(SHELL_EXEC, jsonObjectSchema.parse(args)),
        read: async (args) => request(FS_READ, jsonObjectSchema.parse(args)),
        write: async (args) => request(FS_WRITE, jsonObjectSchema.parse(args)),
        edit: async (args) => request(FS_EDIT, jsonObjectSchema.parse(args)),
        delete: async (args) => request(FS_DELETE, jsonObjectSchema.parse(args)),
        search: async (args) => request(FS_SEARCH, jsonObjectSchema.parse(args)),
      },
    },
    {
      name: "net",
      fns: {
        fetch: async (args) => request(NET_FETCH, jsonObjectSchema.parse(args)),
      },
    },
    {
      name: "__mail",
      fns: {
        send: async (args) => {
          const requestArgs = codeModeMailArgsSchema.parse(args);
          return request(MAIL_SEND, requestArgs);
        },
      },
    },
  ];
  const mcpToolBindings = options?.mcpToolBindings ?? [];
  if (mcpToolBindings.length > 0) {
    const fns: ResolvedProvider["fns"] = {};
    for (const binding of mcpToolBindings) {
      fns[binding.functionName] = async (args) => request(SYS_MCP_CALL, {
        serverId: binding.serverId,
        name: binding.toolName,
        arguments: optionalCodeModeArgsSchema.parse(args),
      });
    }
    providers.push({
      name: "__mcp",
      fns,
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
    const failed: Extract<CodeModeExecResult, { status: "failed" }> = {
      status: "failed",
      error: response.error,
    };
    if (logs) failed.logs = logs;
    return failed;
  }
  const completed: Extract<CodeModeExecResult, { status: "completed" }> = {
    status: "completed",
    result: jsonValueSchema.parse(response.result ?? null),
  };
  if (logs) completed.logs = logs;
  return completed;
}

function codeModeAbortResult(signal: AbortSignal): JsonObject {
  return { __gsvCodeModeAbort: codeModeAbortMessage(signal) };
}

function codeModeAbortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : "CodeMode execution cancelled";
}
