import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import {
  createRoutedFetch,
  normalizeTarget,
  type NetFetchDeviceTransport,
} from "../../../kernel/net";
import { encodeBase64Bytes } from "../../../shared/base64";
import { requireShellOptionValue } from "./common";

type FetchCommandOptions = {
  target: string;
  method: string;
  headers: [string, string][];
  body?: string;
  includeHeaders: boolean;
  headOnly: boolean;
  outputFile?: string;
  timeoutMs?: number;
  json: boolean;
  url: string;
};

type RoutedRequestInit = RequestInit & { timeoutMs?: number };

export function buildNetCommands(
  ctx: KernelContext,
  transport?: NetFetchDeviceTransport,
) {
  const run = async (args: string[], commandCtx: CommandContext, name: string): Promise<ExecResult> => {
    try {
      const normalizedArgs = name === "net" && args[0] === "fetch" ? args.slice(1) : args;
      if (normalizedArgs.includes("--help") || normalizedArgs.includes("-h")) {
        return { stdout: fetchUsage(name), stderr: "", exitCode: 0 };
      }
      const options = parseFetchArgs(normalizedArgs, name);
      const response = await fetchFromOptions(ctx, transport, options);
      if (options.json) {
        const bodyBase64 = encodeBase64Bytes(await response.arrayBuffer());
        return {
          stdout: `${JSON.stringify({
            ok: response.ok,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            bodyBase64,
          }, null, 2)}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      const headers = options.includeHeaders || options.headOnly
        ? formatResponseHeaders(response)
        : "";
      const body = options.headOnly ? "" : await response.text();
      const stdout = headers + body;
      if (options.outputFile) {
        const path = commandCtx.fs.resolvePath(commandCtx.cwd, options.outputFile);
        await commandCtx.fs.writeFile(path, stdout);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout,
        stderr: "",
        exitCode: response.ok ? 0 : 22,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  };

  return [
    defineCommand("net", async (args, commandCtx) => run(args, commandCtx, "net")),
    defineCommand("gsv-fetch", async (args, commandCtx) => run(args, commandCtx, "gsv-fetch")),
  ];
}

async function fetchFromOptions(
  ctx: KernelContext,
  transport: NetFetchDeviceTransport | undefined,
  options: FetchCommandOptions,
): Promise<Response> {
  const fetch = createRoutedFetch(ctx, transport, options.target);
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(new Error(`fetch timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
    : null;
  try {
    const headers = new Headers();
    for (const [key, value] of options.headers) {
      headers.append(key, value);
    }
    const init: RoutedRequestInit = {
      method: options.headOnly ? "HEAD" : options.method,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: controller.signal,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    return await fetch(options.url, init);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function parseFetchArgs(args: string[], commandName: string): FetchCommandOptions {
  const options: Omit<FetchCommandOptions, "url"> = {
    target: "gsv",
    method: "GET",
    headers: [],
    includeHeaders: false,
    headOnly: false,
    json: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--target" || current === "-t") {
      index += 1;
      options.target = normalizeTarget(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current === "-X" || current === "--request") {
      index += 1;
      options.method = normalizeMethod(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current.startsWith("-X") && current.length > 2) {
      options.method = normalizeMethod(current.slice(2));
      continue;
    }
    if (current.startsWith("--request=")) {
      options.method = normalizeMethod(current.slice("--request=".length));
      continue;
    }
    if (current === "-H" || current === "--header") {
      index += 1;
      options.headers.push(parseHeader(requireShellOptionValue(args[index], current)));
      continue;
    }
    if (current.startsWith("--header=")) {
      options.headers.push(parseHeader(current.slice("--header=".length)));
      continue;
    }
    if (current === "-d" || current === "--data" || current === "--data-raw") {
      index += 1;
      options.body = requireShellOptionValue(args[index], current);
      if (options.method === "GET") options.method = "POST";
      continue;
    }
    if (current.startsWith("-d") && current.length > 2) {
      options.body = current.slice(2);
      if (options.method === "GET") options.method = "POST";
      continue;
    }
    if (current.startsWith("--data=")) {
      options.body = current.slice("--data=".length);
      if (options.method === "GET") options.method = "POST";
      continue;
    }
    if (current === "-I" || current === "--head") {
      options.headOnly = true;
      continue;
    }
    if (current === "-i" || current === "--include") {
      options.includeHeaders = true;
      continue;
    }
    if (current === "-o" || current === "--output") {
      index += 1;
      options.outputFile = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "-m" || current === "--max-time") {
      index += 1;
      options.timeoutMs = parseSecondsToMs(requireShellOptionValue(args[index], current));
      continue;
    }
    if (current.startsWith("--max-time=")) {
      options.timeoutMs = parseSecondsToMs(current.slice("--max-time=".length));
      continue;
    }
    if (current === "--json") {
      options.json = true;
      continue;
    }
    if (current === "-s" || current === "-S" || current === "-L" || current === "--location") {
      continue;
    }
    if (current.startsWith("-")) {
      throw new Error(`unsupported option: ${current}`);
    }
    positional.push(current);
  }

  if (positional.length !== 1) {
    throw new Error(`usage: ${commandName === "net" ? "net fetch" : commandName} [--target TARGET] [OPTIONS] URL`);
  }
  return {
    ...options,
    url: normalizeUrl(positional[0]),
  };
}

function normalizeMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error("method must contain only letters");
  }
  return method;
}

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use HTTP or HTTPS");
  }
  return url.toString();
}

function parseHeader(value: string): [string, string] {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error(`invalid header: ${value}`);
  }
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function parseSecondsToMs(value: string): number {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("timeout must be a positive number of seconds");
  }
  return Math.ceil(seconds * 1000);
}

function formatResponseHeaders(response: Response): string {
  const lines = [`HTTP ${response.status} ${response.statusText}`.trim()];
  response.headers.forEach((value, key) => {
    lines.push(`${key}: ${value}`);
  });
  return `${lines.join("\n")}\n\n`;
}

function fetchUsage(commandName: string): string {
  const invocation = commandName === "net" ? "net fetch" : commandName;
  return [
    `usage: ${invocation} [--target TARGET] [OPTIONS] URL`,
    "",
    "Options:",
    "  -t, --target TARGET       use gsv/worker or a connected target id",
    "  -X, --request METHOD      HTTP method",
    "  -H, --header HEADER       add request header",
    "  -d, --data DATA           request body; defaults method to POST",
    "  -I, --head                send HEAD and print headers",
    "  -i, --include             include response headers",
    "  -o, --output FILE         write output to a file",
    "  -m, --max-time SECONDS    request timeout",
    "      --json                print a JSON response envelope",
    "",
  ].join("\n");
}
