import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  AdapterMessageDestination,
  AdapterSendArgs,
  AdapterSendResult,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import { handleAdapterSend } from "../../../kernel/adapter-handlers";
import {
  type VisibleAdapterMessageDestination,
  adapterMessageDestinationId,
  adapterMessageDestinationLabel,
  adapterMessageDestinationRouteKey,
  assertAdapterMessageDestinationAccess,
  listVisibleAdapterMessageDestinations,
  resolveVisibleAdapterMessageDestination,
  updateAdapterMessageDestinationRoute,
} from "../../../kernel/adapter-destinations";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import { findInteractiveProcess, type ProcessRecord } from "../../../kernel/processes";
import type { RunRoute } from "../../../kernel/run-routes";
import type { SurfaceRouteRecord } from "../../../kernel/surface-routes";
import type {
  ProcessRunAttachRequestFrame,
  ProcessRunAttachResult,
} from "../../../protocol/process-frames";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../../../shared/message-media-limits";
import { sendFrameToProcess } from "../../../shared/utils";
import { requireCommandCapability, requireShellOptionValue } from "./common";

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
      return await showCurrentReplyDestination(rest, ctx);
    case "destinations":
      return await listDestinations(rest, ctx);
    case "route":
      return await manageMessageRoute(rest, ctx);
    case "attach":
      return attachToReply(rest, shellCtx, fs, ctx);
    case "send":
      return await sendMessage(rest, shellCtx, fs, ctx);
    case "silence":
      return silenceMessage(rest, ctx);
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
  requireCommandCapability(ctx, "fs.read");
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

  const resources: ResourceBlock[] = [];
  let totalBytes = 0;
  for (const requestedPath of paths) {
    const path = shellCtx.fs.resolvePath(shellCtx.cwd, requestedPath);
    const opened = await fs.openFile(path);
    if (!opened.body) {
      throw new Error(`cannot read attachment data for ${path}`);
    }
    await opened.body.cancel("Attachment will be resolved by immutable revision").catch(() => {});
    if (!opened.etag) {
      throw new Error(`cannot identify an immutable revision for ${path}`);
    }
    if (opened.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
      throw new Error(
        `attachment exceeds per-file limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes): ${path}`,
      );
    }
    totalBytes += opened.size;
    if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
      throw new Error(
        `attachments exceed total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
      );
    }

    const contentType = requestedMime?.trim() || opened.contentType || inferMimeType(path);
    resources.push({
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path,
        revision: opened.etag,
        contentType,
        size: opened.size,
      },
      mediaType: mediaTypeForMime(contentType),
      filename: path.split("/").pop() || "attachment",
    });
  }

  const request: ProcessRunAttachRequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.run.attach",
    args: { runId, media: resources },
  };
  const response = await sendFrameToProcess(ctx.installationId, pid, request);
  if (!response || response.type !== "res" || !response.ok) {
    throw new Error(
      response && response.type === "res" && !response.ok
        ? response.error.message
        : "no response while attaching media to the current reply",
    );
  }
  const result: ProcessRunAttachResult | undefined = response.data;
  if (!result?.ok) {
    throw new Error(result?.error || "failed to attach media to the current reply");
  }
  return completed([
    "attached=true",
    `run_id=${runId}`,
    `count=${result.media.length}`,
    ...result.media.map((item) => `path=${item.ref.path}`),
    "",
  ].join("\n"));
}

async function showCurrentReplyDestination(
  args: string[],
  ctx: KernelContext,
): Promise<ExecResult> {
  const json = parseOnlyFlags(args, new Set(["--json"])).has("--json");
  const route = currentRunRoute(ctx);
  const current = describeCurrentRoute(route);
  const destinationId = route?.kind === "adapter"
    ? await adapterMessageDestinationId(route.destination, resolveCallerOwnerUid(ctx))
    : undefined;
  if (json) {
    // SAFETY: The payload extends the trusted route description with an optional display identifier.
    const payload = { ...current } as RouteDescription & { destinationId?: string };
    if (destinationId) payload.destinationId = destinationId;
    return completed(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return completed([
    `directed endpoint: ${current.label}`,
    `transport: ${current.transport}`,
    ...(destinationId ? [`destination: ${destinationId}`] : []),
    "Finish with `message send --message '...'` here, or `message silence`.",
    "Use `message send --to ... --also` for a separate or cross-channel delivery.",
    "",
  ].join("\n"));
}

async function listDestinations(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "adapter.send");
  const flags = parseOnlyFlags(args, new Set(["--json", "--all"]));
  const destinations = await listVisibleAdapterMessageDestinations(ctx, {
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

async function manageMessageRoute(
  args: string[],
  ctx: KernelContext,
): Promise<ExecResult> {
  requireCommandCapability(ctx, "adapter.route");
  const [action = "show", ...rest] = args;

  if (action === "help" || action === "--help" || action === "-h") {
    return completed(messageRouteUsage());
  }
  if (action === "list") {
    const json = parseOnlyFlags(rest, new Set(["--json"])).has("--json");
    return renderMessageRoutes(await listMessageRoutes(ctx), json);
  }

  if (action === "show" || action === "set" || action === "clear") {
    const options = parseMessageRouteOptions(rest, action === "set");
    const destination = await resolveRouteDestination(options.to, ctx);
    if (action === "show") {
      return renderMessageRoutes([
        messageRouteForDestination(destination, ctx),
      ], options.json);
    }
    if (action === "clear") {
      const cleared = messageRouteForDestination(destination, ctx).route !== null;
      updateAdapterMessageDestinationRoute(destination.destination, null, ctx);
      return completed(options.json
        ? `${JSON.stringify({ cleared, destination: destination.id }, null, 2)}\n`
        : `cleared=${cleared ? "true" : "false"}\ndestination=${destination.id}\n`);
    }

    const process = resolveInteractiveProcess(options.process!, ctx);
    const route = updateAdapterMessageDestinationRoute(
      destination.destination,
      process.processId,
      ctx,
    )!;
    return completed(options.json
      ? `${JSON.stringify({
        routed: true,
        destination: destination.id,
        process: route.pid,
        processLabel: process.label,
      }, null, 2)}\n`
      : [
          "routed=true",
          `destination=${destination.id}`,
          `process=${route.pid}`,
          ...(process.label ? [`process_label=${JSON.stringify(process.label)}`] : []),
          "",
        ].join("\n"));
  }

  throw new Error(`unknown route command: ${action}\n${messageRouteUsage()}`);
}

type MessageRouteView = {
  destination: VisibleAdapterMessageDestination;
  route: SurfaceRouteRecord | null;
  process: ProcessRecord | null;
};

async function listMessageRoutes(ctx: KernelContext): Promise<MessageRouteView[]> {
  const destinations = await listVisibleAdapterMessageDestinations(ctx, {
    includeOffline: true,
    includeUnavailable: true,
  });
  return destinations.map((destination) => messageRouteForDestination(destination, ctx))
    .filter((view) => view.route !== null);
}

function messageRouteForDestination(
  destination: VisibleAdapterMessageDestination,
  ctx: KernelContext,
): MessageRouteView {
  const ownerUid = resolveCallerOwnerUid(ctx);
  assertAdapterMessageDestinationAccess(destination.destination, ownerUid, ctx);
  const route = ctx.adapters.surfaceRoutes.get(
    adapterMessageDestinationRouteKey(destination.destination),
  );
  if (route && route.uid !== ownerUid) {
    throw new Error("Adapter route ownership does not match the linked identity");
  }
  const process = route ? ctx.procs.get(route.pid) : null;
  return {
    destination,
    route,
    process: process?.ownerUid === ownerUid ? process : null,
  };
}

function renderMessageRoutes(routes: MessageRouteView[], json: boolean): ExecResult {
  const rows = routes.map(({ destination, route, process }) => ({
    destination: destination.id,
    chat: destination.label,
    online: destination.online,
    process: route?.pid ?? null,
    processState: route ? process?.state ?? "missing" : null,
    processLabel: process?.label ?? null,
    updatedAt: route?.updatedAt ?? null,
  }));
  if (json) return completed(`${JSON.stringify({ routes: rows }, null, 2)}\n`);

  const lines = ["DESTINATION\tPROCESS\tSTATE\tCHAT\tPROCESS LABEL"];
  for (const row of rows) {
    lines.push([
      row.destination,
      row.process ?? "(none)",
      row.processState ?? "unrouted",
      row.chat,
      row.processLabel ?? "",
    ].join("\t"));
  }
  if (rows.length === 0) lines.push("(none)");
  return completed(`${lines.join("\n")}\n`);
}

type MessageRouteOptions = { to: string; process?: string; json: boolean };
function parseMessageRouteOptions(
  args: string[],
  requireProcess: boolean,
): MessageRouteOptions {
  let to = "here";
  let process: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--to") {
      index += 1;
      to = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--process" && requireProcess) {
      index += 1;
      process = requireShellOptionValue(args[index], current);
      continue;
    }
    if (current === "--json") {
      json = true;
      continue;
    }
    throw new Error(`unexpected argument: ${current}`);
  }
  if (requireProcess && !process) {
    throw new Error("message route set requires --process");
  }
  const parsed: MessageRouteOptions = { to, json };
  if (process) parsed.process = process;
  return parsed;
}

async function resolveRouteDestination(
  query: string,
  ctx: KernelContext,
): Promise<VisibleAdapterMessageDestination> {
  if (query.trim().toLowerCase() !== "here") {
    return resolveVisibleAdapterMessageDestination(query, ctx, {
      includeOffline: true,
      includeUnavailable: true,
    });
  }

  const destination = destinationFromCurrentRoute(ctx);
  const status = ctx.adapters.status.get(destination.adapter, destination.accountId);
  return {
    id: await adapterMessageDestinationId(destination, resolveCallerOwnerUid(ctx)),
    label: adapterMessageDestinationLabel(destination),
    online: status?.connected === true && status.authenticated === true,
    destination,
  };
}

function resolveInteractiveProcess(selector: string, ctx: KernelContext): ProcessRecord {
  const match = findInteractiveProcess(
    selector,
    ctx.procs.list(resolveCallerOwnerUid(ctx)),
  );
  if (match.kind === "found") return match.record;
  if (match.kind === "ambiguous") {
    throw new Error(
      `Process selector is ambiguous: ${match.records.slice(0, 5)
        .map((process) => process.processId).join(", ")}`,
    );
  }
  throw new Error(`No owned interactive process matches: ${selector}`);
}

async function sendMessage(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
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

  const activeRun = Boolean(ctx.processId && ctx.processRunId);
  if (activeRun && !also) {
    throw new Error(
      "the terminal form of message send must be invoked as a direct Shell tool call; use --also for an additional outbound message",
    );
  }
  if (!to) throw new Error("message send requires --to outside its terminal form");
  if (!text?.trim() && !attachmentPath) {
    throw new Error("message send requires --message or --attach");
  }
  if (attachmentMime && !attachmentPath) {
    throw new Error("--mime requires --attach");
  }
  requireCommandCapability(ctx, "adapter.send");

  const destination = to.trim().toLowerCase() === "here"
    ? destinationFromCurrentRoute(ctx)
    : (await resolveVisibleAdapterMessageDestination(to, ctx)).destination;
  const destinationId = await adapterMessageDestinationId(
    destination,
    resolveCallerOwnerUid(ctx),
  );
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
    const sendArgs: AdapterSendArgs = {
      adapter: destination.adapter,
      accountId: destination.accountId,
      deliveryId,
      surface: destination.surface,
      text: text?.trim() ?? "",
      also,
    };
    if (attachment) sendArgs.media = [attachment.media];
    result = await handleAdapterSend(sendArgs, ctx, attachment?.body);
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
    `destination=${destinationId}`,
    `delivery_id=${result.deliveryId}`,
    ...(result.deliveryState ? [`delivery_state=${result.deliveryState}`] : []),
    "",
  ].join("\n"));
}

function silenceMessage(args: string[], ctx: KernelContext): ExecResult {
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current !== "--reason") throw new Error(`unexpected argument: ${current}`);
    if (reason !== undefined) throw new Error("message silence accepts --reason once");
    index += 1;
    reason = requireShellOptionValue(args[index], current);
  }
  if (!ctx.processId || !ctx.processRunId) {
    throw new Error("message silence requires an active process run");
  }
  throw new Error(
    "message silence must be invoked as a direct Shell tool call so the Process can finish the run",
  );
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
  const known = {
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
  return Object.entries(known).find(([key]) => key === extension)?.[1]
    ?? "application/octet-stream";
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
  return route.destination;
}

function currentRunRoute(ctx: KernelContext): RunRoute | null {
  if (!ctx.processId || !ctx.processRunId) {
    return null;
  }
  const route = ctx.runRoutes.get(ctx.processRunId);
  return route?.processId === ctx.processId ? route : null;
}

type RouteDescription = {
  kind: "adapter" | "client" | "process";
  label: string;
  transport: "directed";
};
function describeCurrentRoute(route: RunRoute | null): RouteDescription {
  if (route?.kind === "adapter") {
    const { adapter, surface } = route.destination;
    const adapterLabel = adapter === "whatsapp"
      ? "WhatsApp"
      : adapter.charAt(0).toUpperCase() + adapter.slice(1);
    const surfaceLabel = surface.kind === "dm" ? "direct message" : surface.kind;
    return {
      kind: "adapter",
      label: `${adapterLabel} ${surfaceLabel}`,
      transport: "directed",
    };
  }
  if (route?.kind === "connection") {
    return { kind: "client", label: "the GSV client that started this run", transport: "directed" };
  }
  return { kind: "process", label: "this GSV process history", transport: "directed" };
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
    "  message route show [--to here|DESTINATION] [--json]",
    "  message route list [--json]",
    "  message route set --process PID_OR_LABEL [--to here|DESTINATION] [--json]",
    "  message route clear [--to here|DESTINATION] [--json]",
    "  message attach PATH... [--mime TYPE]",
    "  message send [--message TEXT]",
    "  message silence [--reason TEXT]",
    "  message send --to DESTINATION [--message TEXT] [--attach PATH [--mime TYPE]] [--delivery-id ID] [--also]",
    "",
    "Finish the current run with `message send --message '...'`, or `message silence`.",
    "`message attach` adds files to that eventual terminal message.",
    "Inside an active run, --also is required for a separate or cross-channel send.",
    "Use `message destinations` and copy its opaque GSV id; do not use provider ids.",
    "Use `message route` to inspect routing, open a private-DM work direct line from personal,",
    "or manage groups, channels, and threads.",
    "Copy a remote-device file to GSV first, then pass its local path to --attach.",
    "",
  ].join("\n");
}

function messageRouteUsage(): string {
  return [
    "Usage:",
    "  message route show [--to here|DESTINATION] [--json]",
    "  message route list [--json]",
    "  message route set --process PID_OR_LABEL [--to here|DESTINATION] [--json]",
    "  message route clear [--to here|DESTINATION] [--json]",
    "",
    "`show` and `list` inspect adapter routing. Groups, channels, and threads support `set`",
    "and `clear`. On the exact private DM that started its current run, only the personal",
    "intelligence can use `set` to open a direct line to owned non-personal work.",
    "Use /home inside the DM to return to personal intelligence.",
    "The destination defaults to the current adapter chat. Changes affect future inbound messages;",
    "the current run's terminal message remains directed to the endpoint that started it.",
    "",
  ].join("\n");
}
