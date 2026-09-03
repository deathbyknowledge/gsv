import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import type {
  AdapterMedia,
  AdapterMediaBundle,
  AdapterMessageDestination,
  AdapterSendResult,
  BinaryBody,
  ConversationMessage,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import {
  bundleAdapterMedia,
  cancelBinaryBody,
  contactDisplayName,
  inferFsContentType,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import { hasCapability } from "../../../kernel/capabilities";
import type { KernelContext } from "../../../kernel/context";
import { deliverAdapterDestination } from "../../../kernel/adapter-handlers";
import {
  handleContactDeliveryGet,
  handleContactList,
  handleContactSend,
} from "../../../kernel/federation";
import { handleConversationHistory } from "../../../kernel/conversation-handlers";
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
    case "history":
      return await showMessageHistory(rest, ctx);
    case "delivery":
      return showMessageDelivery(rest, ctx);
    case "send":
      return await sendMessage(rest, shellCtx, fs, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${messageUsage()}`);
  }
}

async function showMessageHistory(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "conversation.history");
  let target: string | undefined;
  let beforeSequence: number | undefined;
  let limit = 50;
  let outputJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--with") {
      index += 1;
      target = requireShellOptionValue(args[index], option);
    } else if (option === "--before") {
      index += 1;
      beforeSequence = parsePositiveInteger(requireShellOptionValue(args[index], option), option);
    } else if (option === "--limit") {
      index += 1;
      limit = parsePositiveInteger(requireShellOptionValue(args[index], option), option);
    } else if (option === "--json") {
      outputJson = true;
    } else {
      throw new Error(`unexpected history option: ${option}`);
    }
  }
  if (!target) throw new Error("message history requires --with CONTACT_OR_CONVERSATION");
  let conversationId = target.trim();
  if (conversationId.startsWith("contact:")) {
    requireCommandCapability(ctx, "contact.list");
    const contact = handleContactList({ includeRevoked: true }, ctx).contacts
      .find(({ id }) => id === conversationId);
    if (!contact) throw new Error(`Contact not found: ${conversationId}`);
    conversationId = contact.conversationId;
  }
  const result = await handleConversationHistory({
    conversationId,
    limit,
    ...(beforeSequence !== undefined ? { beforeSequence } : undefined),
  }, ctx);
  if (outputJson) return completed(`${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `conversation=${result.conversation.id}`,
    `kind=${result.conversation.kind}`,
    `has_more=${result.hasMore ? "true" : "false"}`,
    "",
  ];
  for (const message of result.messages) {
    lines.push(formatConversationMessage(message));
  }
  if (result.messages.length === 0) lines.push("(no messages)");
  lines.push("");
  return completed(lines.join("\n"));
}

function showMessageDelivery(args: string[], ctx: KernelContext): ExecResult {
  const [action, deliveryId, ...rest] = args;
  if (action !== "show" || !deliveryId) {
    throw new Error("message delivery requires: message delivery show DELIVERY_ID [--json]");
  }
  requireCommandCapability(ctx, "contact.delivery.get");
  const flags = parseOnlyFlags(rest, new Set(["--json"]));
  const result = handleContactDeliveryGet({ deliveryId }, ctx);
  if (flags.has("--json")) return completed(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.delivery) throw new Error(`delivery not found: ${deliveryId}`);
  const delivery = result.delivery;
  return completed([
    "accepted=true",
    `delivery_confirmed=${delivery.state === "delivered" ? "true" : "false"}`,
    "transport=federation",
    `destination=${delivery.contactId}`,
    `delivery_id=${delivery.deliveryId}`,
    `delivery_state=${delivery.state}`,
    `conversation_id=${delivery.conversationId}`,
    `attempts=${delivery.attemptCount}`,
    ...(delivery.lastError ? [`last_error=${JSON.stringify(delivery.lastError)}`] : []),
    "",
  ].join("\n"));
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function formatConversationMessage(message: ConversationMessage): string {
  const author = message.author.kind === "user"
    ? `user:${message.author.uid}`
    : message.author.kind === "process"
      ? message.author.pid
      : `${message.author.displayName} (${message.author.contactId})`;
  const lines = [
    `#${message.sequence} ${new Date(message.createdAt).toISOString()} ${author}`,
    message.text || "(resource-only message)",
  ];
  for (const media of message.media ?? []) {
    lines.push(`  resource=${JSON.stringify(media)}`);
  }
  return lines.join("\n");
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
    throw new Error(
      "--mime can only be used with one attachment; omit --mime or attach files separately",
    );
  }

  const resources = await referenceAttachments(paths, requestedMime, shellCtx, fs);

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
    const payload: CurrentConversationDescription = {
      ...current,
      reply: currentConversationReplyInstructions(),
    };
    if (destinationId) {
      payload.destinationId = destinationId;
      payload.destinationUse = "additional-delivery-only";
    }
    return completed(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return completed([
    `current conversation: ${current.label}`,
    `transport: ${current.transport}`,
    "reply command: message send",
    "attachment command: message attach PATH...",
    "Issue each as its own direct Shell tool call; omit --to and --also.",
    "A reply commits to this conversation without finishing the run.",
    "Run `yield` when the work is complete, or compose the final send with `&& yield`.",
    ...(destinationId
      ? [`additional adapter destination: ${destinationId}`]
      : []),
    "Use `message send --to DESTINATION --also` only for an additional delivery.",
    "",
  ].join("\n"));
}

async function listDestinations(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const flags = parseOnlyFlags(args, new Set(["--json", "--all"]));
  const capabilities = ctx.identity?.capabilities ?? [];
  const canListAdapters = hasCapability(capabilities, "adapter.send");
  const canListContacts = hasCapability(capabilities, "contact.list");
  if (!canListAdapters && !canListContacts) {
    throw new Error("Permission denied: no message destination capability");
  }
  const adapters = canListAdapters
    ? await listVisibleAdapterMessageDestinations(ctx, {
        includeOffline: flags.has("--all"),
      })
    : [];
  const contacts = canListContacts
    ? handleContactList({ includeRevoked: flags.has("--all") }, ctx).contacts
    : [];
  const destinations = [
    ...adapters.map((entry) => ({
      id: entry.id,
      kind: "adapter" as const,
      label: entry.label,
      state: entry.online ? "online" : "offline",
      online: entry.online,
    })),
    ...contacts.map((contact) => ({
      id: contact.id,
      kind: "contact" as const,
      label: contactDisplayName(contact),
      state: contact.state,
      online: null,
    })),
  ];
  if (flags.has("--json")) {
    return completed(`${JSON.stringify({ destinations }, null, 2)}\n`);
  }
  const lines = ["DESTINATION\tSTATE\tLABEL"];
  for (const destination of destinations) {
    lines.push([
      destination.id,
      destination.state,
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
  const attachmentPaths: string[] = [];
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
      attachmentPaths.push(requireShellOptionValue(args[index], current));
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

  if (attachmentPaths.length > MAX_MESSAGE_MEDIA_ITEMS) {
    throw new Error(`message send accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} attachments`);
  }
  if (attachmentMime && attachmentPaths.length === 0) {
    throw new Error("--mime requires --attach");
  }
  if (attachmentMime && attachmentPaths.length > 1) {
    throw new Error(
      "--mime can only be used with one attachment; omit --mime or send files separately",
    );
  }

  const activeRun = Boolean(ctx.processId && ctx.processRunId);
  if (activeRun && !also) {
    throw new Error(
      "the current-conversation form of message send must be invoked as a direct Shell tool "
      + "call: stage files first with `message attach PATH...`, then issue `message send ...` "
      + "without --to or --also. Use --also only for an explicit additional destination",
    );
  }
  if (!to) throw new Error("message send requires --to outside its direct current-conversation form");
  if (!text?.trim() && attachmentPaths.length === 0) {
    throw new Error("message send requires --message or --attach");
  }
  const requestedDestination = to.trim();
  if (requestedDestination.toLowerCase() === "here") {
    throw new Error(
      "--to here is not a message destination. To reply to the current conversation, "
      + "stage files with `message attach PATH...`, then issue `message send ...` as its own "
      + "direct Shell tool call without --to or --also. For an additional adapter delivery, "
      + "copy an opaque destination from `message current --json` or `message destinations`",
    );
  }
  if (requestedDestination.startsWith("contact:")) {
    requireCommandCapability(ctx, "contact.send");
    const media = attachmentPaths.length > 0
      ? await referenceAttachments(attachmentPaths, attachmentMime, shellCtx, fs)
      : undefined;
    const contactResult = await handleContactSend({
      contactId: requestedDestination,
      text: text?.trim() ?? "",
      ...(media ? { media } : undefined),
      ...(requestedDeliveryId ? { idempotencyKey: requestedDeliveryId } : undefined),
    }, ctx);
    const delivered = contactResult.state === "delivered";
    return completed([
      "accepted=true",
      `delivery_confirmed=${delivered ? "true" : "false"}`,
      "transport=federation",
      `destination=${requestedDestination}`,
      `delivery_id=${contactResult.deliveryId}`,
      `delivery_state=${contactResult.state}`,
      `conversation_id=${contactResult.conversationId}`,
      "",
    ].join("\n"));
  }

  requireCommandCapability(ctx, "adapter.send");

  const destination = (await resolveVisibleAdapterMessageDestination(
    requestedDestination,
    ctx,
  )).destination;
  const destinationId = await adapterMessageDestinationId(
    destination,
    resolveCallerOwnerUid(ctx),
  );
  const deliveryId = requestedDeliveryId?.trim() || crypto.randomUUID();
  let result: AdapterSendResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let attachments: AdapterMediaBundle | null;
    try {
      attachments = attachmentPaths.length > 0
        ? await openAttachments(attachmentPaths, attachmentMime, shellCtx, fs)
        : null;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + `(delivery_id=${deliveryId}; retry with --delivery-id using this value)`,
      );
    }
    const sendArgs: Parameters<typeof deliverAdapterDestination>[2] = {
      deliveryId,
      text: text?.trim() ?? "",
    };
    if (attachments) sendArgs.media = attachments.media;
    result = await deliverAdapterDestination(
      destination,
      resolveCallerOwnerUid(ctx),
      sendArgs,
      ctx,
      attachments?.body,
    );
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

async function referenceAttachments(
  requestedPaths: string[],
  requestedMime: string | undefined,
  shellCtx: CommandContext,
  fs: GsvFs,
): Promise<ResourceBlock[]> {
  const resources: ResourceBlock[] = [];
  let totalBytes = 0;
  for (const requestedPath of requestedPaths) {
    const resource = await referenceAttachment(requestedPath, requestedMime, shellCtx, fs);
    totalBytes += resource.ref.size;
    if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
      throw new Error(
        `attachments exceed total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
      );
    }
    resources.push(resource);
  }
  return resources;
}

async function referenceAttachment(
  requestedPath: string,
  requestedMime: string | undefined,
  shellCtx: CommandContext,
  fs: GsvFs,
): Promise<ResourceBlock> {
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
  const contentType = opened.contentType ?? inferFsContentType(path);
  const presentationContentType = requestedMime?.trim() || contentType;
  return {
    type: "resource",
    ref: {
      type: "file",
      target: "gsv",
      path,
      revision: opened.etag,
      contentType,
      size: opened.size,
    },
    mediaType: mediaTypeForMime(presentationContentType),
    filename: path.split("/").pop() || "attachment",
  };
}

type OpenAttachment = {
  media: Omit<AdapterMedia, "body">;
  body: BinaryBody & { length: number };
};

async function openAttachments(
  requestedPaths: string[],
  requestedMime: string | undefined,
  shellCtx: CommandContext,
  fs: GsvFs,
): Promise<AdapterMediaBundle> {
  const parts: OpenAttachment[] = [];
  let totalBytes = 0;
  try {
    for (const requestedPath of requestedPaths) {
      const part = await openAttachment(requestedPath, requestedMime, shellCtx, fs);
      parts.push(part);
      if (part.body.length > MAX_MESSAGE_MEDIA_PART_BYTES) {
        throw new Error(
          `attachment exceeds per-file limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes): ${requestedPath}`,
        );
      }
      totalBytes += part.body.length;
      if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        throw new Error(
          `attachments exceed total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
        );
      }
    }
    return await bundleAdapterMedia(parts);
  } catch (error) {
    await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
    throw error;
  }
}

async function openAttachment(
  requestedPath: string,
  requestedMime: string | undefined,
  shellCtx: CommandContext,
  fs: GsvFs,
): Promise<OpenAttachment> {
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

type CurrentConversationDescription = RouteDescription & {
  reply: ReturnType<typeof currentConversationReplyInstructions>;
  destinationId?: string;
  destinationUse?: "additional-delivery-only";
};

function currentConversationReplyInstructions() {
  return {
    command: "message send",
    attachmentCommand: "message attach PATH...",
    requiresStandaloneShellCall: true,
    finishesRun: false,
  } as const;
}
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
    "  message history --with CONTACT_OR_CONVERSATION [--before SEQUENCE] [--limit N] [--json]",
    "  message delivery show DELIVERY_ID [--json]",
    "  message send [--message TEXT]",
    "  message send --to DESTINATION [--message TEXT] [--attach PATH]... [--mime TYPE] [--delivery-id ID] [--also]",
    "",
    "A literal `message send <<'GSV_MESSAGE'` block sends to the current conversation and keeps the run active.",
    "Run `yield` when work is complete, or append `&& yield` to the message block header.",
    "`message attach` adds files to the next current-conversation message.",
    "Do not use --to or --also for the current conversation. Issue current-conversation",
    "attach and send commands as separate direct Shell tool calls.",
    "Inside an active run, --also is required for an additional destination send.",
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
    "Use /ship inside the DM to return to Ship.",
    "The destination defaults to the current adapter chat. Changes affect future inbound messages;",
    "the current run's direct messages remain directed to the endpoint that started it.",
    "",
  ].join("\n");
}
