import type { GsvDriverHandler, GsvDriverRequest } from "@humansandmachines/gsv/client";
import type { ActivityEntry, ActivityKind, ActivityStatus } from "../shared/ui-state";
import { createBrowserCommands } from "../target/commands";
import { BrowserFsDriver, BrowserTargetFileSystem } from "../target/fs";
import { createRuntimeFileSystem } from "../target/runtime-fs";
import { BrowserTargetShell } from "../target/shell";

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
    async handle(request, context): Promise<unknown> {
      const startedAt = Date.now();
      const baseActivity = activityForFrame(request);
      try {
        let result: unknown;
        if (request.call === "shell.exec") {
          result = await shell.exec(request.args);
        } else if (request.call.startsWith("fs.")) {
          result = await fsDriver.handle(request.call, request.args, context.binary);
        } else {
          throw new Error(`Unsupported browser target syscall: ${request.call}`);
        }
        observeActivity?.({
          ...baseActivity,
          detail: detailWithResultPath(baseActivity.detail, result),
          status: statusForResult(result),
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        observeActivity?.({
          kind: "error",
          label: baseActivity.label,
          detail: truncate(`${baseActivity.detail}: ${errorMessage(error)}`, 180),
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
    const input = shellInput(frame.args);
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
      detail: truncate(pathDetail(frame.args), 180),
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

function shellInput(args: unknown): string {
  const record = asRecord(args);
  return typeof record.input === "string" ? record.input.trim() : "";
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
  return parts[0];
}

function classifyShellCommand(command: string): ActivityKind {
  const first = command.split(/\s+/)[0] ?? "";
  if (first === "network") {
    return "network";
  }
  if (["bookmarks", "clipboard", "cookies", "downloads", "history", "page", "storage"].includes(first)) {
    return "sensitive";
  }
  return "shell";
}

function classifyFsCall(call: string): ActivityKind {
  return ["fs.write", "fs.edit", "fs.delete", "fs.copy", "fs.transfer.receive"].includes(call)
    ? "sensitive"
    : "fs";
}

function pathDetail(args: unknown): string {
  const record = asRecord(args);
  const path = typeof record.path === "string" ? record.path : "";
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

function endpointPath(value: unknown): string {
  const record = asRecord(value);
  return typeof record.path === "string" ? record.path : "";
}

function statusForResult(result: unknown): ActivityStatus {
  const record = asRecord(result);
  if (record.status === "failed" || record.ok === false) {
    return "error";
  }
  const exitCode = record.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return "error";
  }
  return "ok";
}

function detailWithResultPath(detail: string, result: unknown): string {
  const path = resultPath(result);
  if (!path || detail.includes(path)) {
    return detail;
  }
  return truncate(`${detail} -> ${path}`, 220);
}

function resultPath(result: unknown): string | null {
  const record = asRecord(result);
  const text = typeof record.output === "string" ? record.output : "";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
