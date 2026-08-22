import type {
  GsvDriverContext,
  GsvDriverHandler,
  GsvDriverRequest,
  GsvResponse,
} from "@humansandmachines/gsv/client";
import type { ActivityEntry, ActivityKind, ActivityStatus } from "../shared/ui-state";
import { createBrowserCommands } from "../target/commands";
import { BrowserFsDriver, BrowserTargetFileSystem } from "../target/fs";
import { createRuntimeFileSystem } from "../target/runtime-fs";
import { BrowserTargetShell } from "../target/shell";
import { isNumber, isString } from "../shared/schemas";

export type BrowserTargetActivity = Omit<ActivityEntry, "id" | "at">;
export type BrowserTargetActivityObserver = (activity: BrowserTargetActivity) => void;

export type BrowserTargetDriver = {
  handle: GsvDriverHandler;
};

export function createBrowserTargetDriver(
  observeActivity?: BrowserTargetActivityObserver,
): BrowserTargetDriver {
  const fs = new BrowserTargetFileSystem(createRuntimeFileSystem());
  const fsDriver = new BrowserFsDriver(fs);
  const shell = new BrowserTargetShell(fs, createBrowserCommands());

  return {
    async handle(request, context): Promise<GsvResponse> {
      const startedAt = Date.now();
      const baseActivity = activityForFrame(request);
      try {
        let response: GsvResponse;
        if (request.call === "shell.exec") {
          response = {
            data: await shell.exec(request.args, {
              currentTargetId: currentTargetId(context),
              abortSignal: context.abortSignal,
              copyTargetFile: async (source, destination) => await context.client.call("fs.copy", {
                source,
                destination,
              }),
            }),
          };
        } else if (request.call.startsWith("fs.")) {
          response = await fsDriver.handle(request.call, request.args, request.body, context.abortSignal);
        } else {
          throw new Error(`Unsupported browser target syscall: ${request.call}`);
        }
        const result = response.data;
        observeActivity?.({
          ...baseActivity,
          // SAFETY: gateway syscall responses are JSON protocol values.
          // SAFETY: syscall responses are JSON protocol values.
          detail: detailWithResultPath(baseActivity.detail, result as ExtensionBoundaryValue),
          // SAFETY: syscall responses are JSON protocol values.
          status: statusForResult(result as ExtensionBoundaryValue),
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        observeActivity?.({
          kind: "error",
          label: baseActivity.label,
          // SAFETY: rejected syscall operations are Error-compatible values.
          detail: truncate(`${baseActivity.detail}: ${errorMessage(error as Error)}`, 180),
          status: "error",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

function activityForFrame(frame: GsvDriverRequest): BrowserTargetActivity {
  if (frame.call === "shell.exec") {
    // SAFETY: gateway syscall arguments are JSON protocol values.
    const input = shellInput(frame.args as ExtensionBoundaryValue);
    const command = firstShellCommand(input);
    return {
      kind: classifyShellCommand(command),
      label: shellLabel(command),
      detail: truncate(redact(command || input || "shell.exec"), 180),
      status: "active",
    };
  }

  if (frame.call.startsWith("fs.")) {
    return {
      kind: frame.call === "fs.read" ? "fs" : classifyFsCall(frame.call),
      label: frame.call,
      // SAFETY: gateway syscall arguments are JSON protocol values.
      detail: truncate(pathDetail(frame.args as ExtensionBoundaryValue), 180),
      status: "active",
    };
  }

  return {
    kind: "error",
    label: frame.call,
    detail: "unsupported syscall",
    status: "error",
  };
}

function shellInput(args: ExtensionBoundaryValue): string {
  const record = asRecord(args);
  return isString(record.input) ? record.input.trim() : "";
}

function firstShellCommand(input: string): string {
  const line = input.split("\n").map((candidate) => candidate.trim()).find(Boolean) ?? "";
  return line.replace(/\s+/g, " ");
}

function shellLabel(command: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "shell.exec";
  }
  if (parts[0] === "page" && parts[1]) {
    return `page ${parts[1]}`;
  }
  if (parts[0] === "network" && parts[1]) {
    return `network ${parts[1]}`;
  }
  if (parts[0] === "media" && parts[1]) {
    return parts[2] ? `media ${parts[1]} ${parts[2]}` : `media ${parts[1]}`;
  }
  return parts[0];
}

function classifyShellCommand(command: string): ActivityKind {
  const first = command.split(/\s+/)[0] ?? "";
  if (first === "network") {
    return "network";
  }
  if (["bookmarks", "clipboard", "cookies", "downloads", "history", "media", "page", "storage"].includes(first)) {
    return "sensitive";
  }
  return "shell";
}

function currentTargetId(context: GsvDriverContext): string | undefined {
  return context.connection.identity.role === "driver"
    ? context.connection.identity.device
    : undefined;
}

function classifyFsCall(call: string): ActivityKind {
  return ["fs.write", "fs.edit", "fs.delete", "fs.copy", "fs.transfer.receive"].includes(call)
    ? "sensitive"
    : "fs";
}

function pathDetail(args: ExtensionBoundaryValue): string {
  const record = asRecord(args);
  const path = isString(record.path) ? record.path : "";
  if (path) {
    return path;
  }
  const source = endpointPath(record.source);
  const destination = endpointPath(record.destination);
  if (source || destination) {
    return `${source || "?"} -> ${destination || "?"}`;
  }
  return "(no path)";
}

function endpointPath(value: ExtensionBoundaryValue): string {
  const record = asRecord(value);
  return isString(record.path) ? record.path : "";
}

function statusForResult(result: ExtensionBoundaryValue): ActivityStatus {
  const record = asRecord(result);
  if (record.status === "failed" || record.ok === false) {
    return "error";
  }
  const exitCode = record.exitCode;
  if (isNumber(exitCode) && exitCode !== 0) {
    return "error";
  }
  return "ok";
}

function detailWithResultPath(detail: string, result: ExtensionBoundaryValue): string {
  const path = resultPath(result);
  if (!path || detail.includes(path)) {
    return detail;
  }
  return truncate(`${detail} -> ${path}`, 220);
}

function resultPath(result: ExtensionBoundaryValue): string | null {
  const record = asRecord(result);
  const text = isString(record.output) ? record.output : "";
  if (!text) {
    return null;
  }
  const jsonPath = text.match(/"(?:path|sessionPath)"\s*:\s*"([^"]+)"/);
  if (jsonPath?.[1]) {
    return jsonPath[1];
  }
  const browserPath = text.match(/\/home\/browser\/[^\s"',}]+/);
  return browserPath?.[0] ?? null;
}

function redact(value: string): string {
  return value
    .replace(/(token|password|authorization|cookie)=\S+/gi, "$1=<redacted>")
    .replace(/(Bearer)\s+\S+/gi, "$1 <redacted>");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function errorMessage(error: ExtensionBoundaryValue | Error): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: ExtensionBoundaryValue): { [key: string]: ExtensionBoundaryValue } {
  // SAFETY: callers use this helper only after accepting JSON-like external values.
  return value && !Array.isArray(value) && Object(value) === value ? value as { [key: string]: ExtensionBoundaryValue } : {};
}
