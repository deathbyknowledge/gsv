import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  AdapterMessageDestination,
  AdapterSendResult,
  ProcMediaInput,
  ProcMediaWriteResult,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { handleAdapterSend } from "../../../kernel/adapter-handlers";
import {
  listVisibleAdapterMessageDestinations,
  resolveVisibleAdapterMessageDestination,
} from "../../../kernel/adapter-destinations";
import type { AdapterRunRoute, RunRoute } from "../../../kernel/run-routes";
import type { RequestFrame } from "../../../protocol/frames";
import type {
  ProcessRunAttachRequestFrame,
  ProcessRunAttachResult,
} from "../../../protocol/process-frames";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../../../shared/message-media-limits";
import {
  parseProcessMediaPath,
  processMediaPrefix,
} from "../../../shared/process-media-path";
import { sendFrameToProcess } from "../../../shared/utils";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type ReplyAttachment = ProcMediaInput & {
  key: string;
  path: string;
  size: number;
};

export function buildMessageCommand(fs: GsvFs, ctx: KernelContext) {
  return defineCommand("message", async (args, shellCtx): Promise<ExecResult> => {
    try {
      return await runMessageCommand(args, shellCtx, fs, ctx);
    } catch (error) {
      return {
        stdout: "",
        stderr: `message: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runMessageCommand(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return completed(messageUsage());
    case "current":
      return showCurrentReplyDestination(rest, ctx);
    case "destinations":
    case "targets":
      return listDestinations(rest, ctx);
    case "attach":
      return attachToReply(rest, shellCtx, fs, ctx);
    case "send":
      return sendMessage(rest, shellCtx, fs, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${messageUsage()}`);
  }
}

async function attachToReply(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "proc.media.write");
  const pid = ctx.processId;
  const runId = ctx.processRunId;
  if (!pid || !runId) {
    throw new Error("message attach requires an active process run");
  }

  const paths: string[] = [];
  let requestedMime: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--mime") {
      index += 1;
      requestedMime = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(`unexpected argument: ${current}`);
    }
    paths.push(current);
  }
  if (paths.length === 0) {
    throw new Error("message attach requires at least one path");
  }
  if (paths.length > MAX_MESSAGE_MEDIA_ITEMS) {
    throw new Error(`message attach accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} files`);
  }
  if (requestedMime && paths.length !== 1) {
    throw new Error("--mime can only be used with one attachment");
  }

  const staged: ReplyAttachment[] = [];
  const stagedKeys: string[] = [];
  let totalBytes = 0;
  try {
    for (const requestedPath of paths) {
      const path = shellCtx.fs.resolvePath(shellCtx.cwd, requestedPath);
      const opened = await fs.openFile(path);
      if (!opened.body) {
        throw new Error(`cannot read attachment data for ${path}`);
      }
      if (opened.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
        await opened.body.cancel("Reply attachment exceeds the per-file limit").catch(() => {});
        throw new Error(
          `attachment exceeds per-file limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes): ${path}`,
        );
      }
      totalBytes += opened.size;
      if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        await opened.body.cancel("Reply attachments exceed the total limit").catch(() => {});
        throw new Error(
          `attachments exceed total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
        );
      }

      const mimeType = requestedMime?.trim() || opened.contentType || inferMimeType(path);
      const parsed = parseProcessMediaPath(path);
      if (
        parsed?.kind === "file"
        && parsed.uid === ctx.identity!.process.uid
        && parsed.pid === pid
      ) {
        await opened.body.cancel("Reusing process-owned media").catch(() => {});
        staged.push({
          type: mediaTypeForMime(mimeType),
          mimeType,
          key: parsed.key,
          path,
          filename: path.split("/").pop() || "attachment",
          size: opened.size,
        });
        continue;
      }

      const mediaId = `reply:${crypto.randomUUID()}`;
      const stagedKey = `${processMediaPrefix(ctx.identity!.process.uid, pid)}${mediaId}`;
      stagedKeys.push(stagedKey);
      const request: RequestFrame<"proc.media.write"> = {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.media.write",
        args: {
          pid,
          type: mediaTypeForMime(mimeType),
          mimeType,
          mediaId,
          filename: path.split("/").pop() || "attachment",
        },
        body: { stream: opened.body, length: opened.size },
      };
      const response = await sendFrameToProcess(pid, request);
      if (!response || response.type !== "res" || !response.ok) {
        throw new Error(
          response && response.type === "res" && !response.ok
            ? response.error.message
            : `no response while staging ${path}`,
        );
      }
      const result = response.data as ProcMediaWriteResult | undefined;
      if (!result?.ok) {
        throw new Error(result?.error || `failed to stage ${path}`);
      }
      if (result.media.key !== stagedKey) {
        throw new Error(`staged media key did not match the requested id for ${path}`);
      }
      staged.push(result.media as ReplyAttachment);
    }

    const request: ProcessRunAttachRequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.run.attach",
      args: {
        runId,
        media: staged,
        ...(stagedKeys.length > 0 ? { stagedKeys } : {}),
      },
    };
    const response = await sendFrameToProcess(pid, request);
    if (!response || response.type !== "res" || !response.ok) {
      throw new Error(
        response && response.type === "res" && !response.ok
          ? response.error.message
          : "no response while attaching media to the current reply",
      );
    }
    const result = response.data as ProcessRunAttachResult | undefined;
    if (!result?.ok) {
      throw new Error(result?.error || "failed to attach media to the current reply");
    }
    return completed([
      "attached=true",
      `run_id=${runId}`,
      `count=${result.media.length}`,
      ...result.media.map((item) => `path=${item.path}`),
      "",
    ].join("\n"));
  } catch (error) {
    await rollbackStagedReplyMedia(pid, stagedKeys);
    throw error;
  }
}

async function rollbackStagedReplyMedia(pid: string, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.media.delete",
    args: { pid, key },
  } as RequestFrame<"proc.media.delete">)));
}

function showCurrentReplyDestination(args: string[], ctx: KernelContext): ExecResult {
  const json = parseOnlyFlags(args, new Set(["--json"])).has("--json");
  const route = currentRunRoute(ctx);
  const current = describeCurrentRoute(route);
  if (json) {
    return completed(`${JSON.stringify(current, null, 2)}\n`);
  }
  return completed([
    `automatic reply: ${current.label}`,
    `transport: ${current.transport}`,
    "Explicit `message send` commands create additional outbound messages.",
    "Return the current answer normally unless an additional or cross-channel message was requested.",
    "",
  ].join("\n"));
}

function listDestinations(args: string[], ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, "adapter.send");
  const flags = parseOnlyFlags(args, new Set(["--json", "--all"]));
  const destinations = listVisibleAdapterMessageDestinations(ctx, {
    includeOffline: flags.has("--all"),
  });
  if (flags.has("--json")) {
    return completed(`${JSON.stringify({
      destinations: destinations.map((entry) => ({
        id: entry.id,
        label: entry.label,
        online: entry.online,
      })),
    }, null, 2)}\n`);
  }
  const lines = ["DESTINATION\tSTATE\tLABEL"];
  for (const destination of destinations) {
    lines.push([
      destination.id,
      destination.online ? "online" : "offline",
      destination.label,
    ].join("\t"));
  }
  if (destinations.length === 0) {
    lines.push("(none)");
  }
  return completed(`${lines.join("\n")}\n`);
}

async function sendMessage(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "adapter.send");
  let to: string | undefined;
  let text: string | undefined;
  let attachmentPath: string | undefined;
  let attachmentMime: string | undefined;
  let requestedDeliveryId: string | undefined;
  let also = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--to") {
      index += 1;
      to = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--message") {
      index += 1;
      text = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--attach") {
      index += 1;
      attachmentPath = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--mime") {
      index += 1;
      attachmentMime = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--delivery-id") {
      index += 1;
      requestedDeliveryId = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--also") {
      also = true;
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }

  if (!to) {
    throw new Error("message send requires --to");
  }
  if (!text?.trim() && !attachmentPath) {
    throw new Error("message send requires --message or --attach");
  }
  if (attachmentMime && !attachmentPath) {
    throw new Error("--mime requires --attach");
  }

  const destination = to.trim().toLowerCase() === "here"
    ? destinationFromCurrentRoute(ctx)
    : resolveVisibleAdapterMessageDestination(to, ctx).destination;
  const deliveryId = requestedDeliveryId?.trim() || crypto.randomUUID();
  let result: AdapterSendResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let attachment: Awaited<ReturnType<typeof openAttachment>> | null;
    try {
      attachment = attachmentPath
        ? await openAttachment(attachmentPath, attachmentMime, shellCtx, fs)
        : null;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + `(delivery_id=${deliveryId}; retry with --delivery-id using this value)`,
      );
    }
    result = await handleAdapterSend({
      adapter: destination.adapter,
      accountId: destination.accountId,
      deliveryId,
      surface: destination.surface,
      text: text?.trim() ?? "",
      ...(attachment ? { media: [attachment.media] } : {}),
      also,
    }, ctx, attachment?.body);
    if (result.ok || !result.retryable) break;
  }
  if (!result) {
    throw new Error(`delivery did not run (delivery_id=${deliveryId})`);
  }
  if (!result.ok) {
    throw new Error(
      `${result.error} (delivery_id=${result.deliveryId ?? deliveryId}${
        result.retryable ? "; retry with --delivery-id using this value" : ""
      })`,
    );
  }
  const deliveryConfirmed = result.deliveryState !== "ambiguous";
  return completed([
    `sent=${deliveryConfirmed ? "true" : "false"}`,
    `delivery_confirmed=${deliveryConfirmed ? "true" : "false"}`,
    `adapter=${result.adapter}`,
    `account=${result.accountId}`,
    `destination=${result.surfaceId}`,
    `delivery_id=${result.deliveryId}`,
    ...(result.deliveryState ? [`delivery_state=${result.deliveryState}`] : []),
    ...(result.messageId ? [`message_id=${result.messageId}`] : []),
    "",
  ].join("\n"));
}

async function openAttachment(
  requestedPath: string,
  requestedMime: string | undefined,
  shellCtx: CommandContext,
  fs: GsvFs,
): Promise<{
  media: {
    type: "image" | "audio" | "video" | "document";
    mimeType: string;
    filename: string;
    size: number;
    body: { offset: number; length: number };
  };
  body: { stream: ReadableStream<Uint8Array>; length: number };
}> {
  const path = shellCtx.fs.resolvePath(shellCtx.cwd, requestedPath);
  const opened = await fs.openFile(path);
  if (!opened.body) {
    throw new Error(`cannot read attachment data for ${path}`);
  }
  const mimeType = requestedMime?.trim() || opened.contentType || inferMimeType(path);
  const length = opened.size;
  return {
    media: {
      type: mediaTypeForMime(mimeType),
      mimeType,
      filename: path.split("/").pop() || "attachment",
      size: length,
      body: { offset: 0, length },
    },
    body: { stream: opened.body, length },
  };
}

function inferMimeType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    txt: "text/plain",
  };
  return known[extension ?? ""] ?? "application/octet-stream";
}

function mediaTypeForMime(mimeType: string): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function destinationFromCurrentRoute(ctx: KernelContext): AdapterMessageDestination {
  const route = currentRunRoute(ctx);
  if (route?.kind !== "adapter") {
    throw new Error("the current run does not have an adapter reply destination");
  }
  return destinationFromAdapterRoute(route);
}

function currentRunRoute(ctx: KernelContext): RunRoute | null {
  if (!ctx.processId || !ctx.processRunId) {
    return null;
  }
  const route = ctx.runRoutes.get(ctx.processRunId);
  return route?.processId === ctx.processId ? route : null;
}

function destinationFromAdapterRoute(route: AdapterRunRoute): AdapterMessageDestination {
  return {
    kind: "adapter",
    adapter: route.adapter,
    accountId: route.accountId,
    actorId: route.actorId,
    surface: {
      kind: route.surfaceKind,
      id: route.surfaceId,
      ...(route.threadId ? { threadId: route.threadId } : {}),
    },
  };
}

function describeCurrentRoute(route: RunRoute | null): {
  kind: "adapter" | "client" | "conversation";
  label: string;
  transport: "automatic";
} {
  if (route?.kind === "adapter") {
    const adapter = route.adapter === "whatsapp"
      ? "WhatsApp"
      : route.adapter.charAt(0).toUpperCase() + route.adapter.slice(1);
    const surface = route.surfaceKind === "dm" ? "direct message" : route.surfaceKind;
    return { kind: "adapter", label: `${adapter} ${surface}`, transport: "automatic" };
  }
  if (route?.kind === "connection") {
    return { kind: "client", label: "the GSV client that started this run", transport: "automatic" };
  }
  return { kind: "conversation", label: "this GSV process conversation", transport: "automatic" };
}

function parseOnlyFlags(args: string[], allowed: Set<string>): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    flags.add(arg);
  }
  return flags;
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function messageUsage(): string {
  return [
    "Usage:",
    "  message current [--json]",
    "  message destinations [--all] [--json]",
    "  message attach PATH... [--mime TYPE]",
    "  message send --to DESTINATION [--message TEXT] [--attach PATH [--mime TYPE]] [--delivery-id ID] [--also]",
    "",
    "The current run's final response is delivered automatically.",
    "`message attach` includes files in that same final response.",
    "`message send` creates an additional outbound message. Use --to here --also only when an",
    "extra message on the current reply surface is intentional.",
    "Copy a remote-device file to GSV first, then pass its local path to --attach.",
    "",
  ].join("\n");
}
