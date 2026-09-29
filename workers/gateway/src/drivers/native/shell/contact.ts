import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type {
  ContactRequestCreateArgs,
  ContactRequestState,
  ContactRequestUpdateArgs,
} from "@humansandmachines/gsv/protocol";
import { contactDisplayName, jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import {
  handleContactAliasSet,
  handleContactIdentity,
  handleContactInviteAccept,
  handleContactInviteCancel,
  handleContactInviteCreate,
  handleContactInviteList,
  handleContactList,
  handleContactRequestCreate,
  handleContactRequestList,
  handleContactRequestUpdate,
  handleContactRevoke,
} from "../../../kernel/federation";
import {
  parseDurationMs,
  requireCommandCapability,
  requireShellOptionValue,
} from "./common";
import * as z from "zod/mini";

const requestStateSchema = z.enum([
  "accepted",
  "rejected",
  "active",
  "completed",
  "cancelled",
]);

export function buildContactCommand(ctx: KernelContext) {
  return defineCommand("contact", async (args): Promise<ExecResult> => {
    try {
      return await runContactCommand(args, ctx);
    } catch (error) {
      return {
        stdout: "",
        stderr: `contact: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runContactCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return completed(contactUsage());
    case "identity":
      requireCommandCapability(ctx, "contact.identity");
      requireArgumentCount(rest, 0, "identity accepts no arguments");
      return json(await handleContactIdentity(ctx));
    case "list":
      return listContacts(rest, ctx);
    case "alias":
      requireCommandCapability(ctx, "contact.alias.set");
      if (rest.length < 2) {
        throw new Error("alias requires: contact alias CONTACT_ID NAME|--clear");
      }
      return json(handleContactAliasSet({
        contactId: rest[0],
        alias: rest[1] === "--clear" && rest.length === 2 ? null : rest.slice(1).join(" "),
      }, ctx));
    case "invite":
      return await manageInvite(rest, ctx);
    case "revoke":
      requireCommandCapability(ctx, "contact.revoke");
      requireArgumentCount(rest, 1, "revoke requires: contact revoke CONTACT_ID");
      return json(await handleContactRevoke({ contactId: rest[0] }, ctx));
    case "request":
      return await manageRequest(rest, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${contactUsage()}`);
  }
}

function listContacts(args: string[], ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, "contact.list");
  const flags = parseOnlyFlags(args, new Set(["--all", "--json"]));
  const result = handleContactList({ includeRevoked: flags.has("--all") }, ctx);
  if (flags.has("--json")) return json(result);
  const lines = ["CONTACT\tSTATE\tNAME\tSHIP"];
  for (const contact of result.contacts) {
    lines.push([
      contact.id,
      contact.state,
      contactDisplayName(contact),
      contact.remoteShipId,
    ].join("\t"));
  }
  if (result.contacts.length === 0) lines.push("(none)");
  return completed(`${lines.join("\n")}\n`);
}

async function manageInvite(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [action, ...rest] = args;
  if (action === "create") {
    requireCommandCapability(ctx, "contact.invite.create");
    let expiresInSeconds: number | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const option = rest[index];
      if (option !== "--expires") throw new Error(`unexpected invite option: ${option}`);
      index += 1;
      const durationMs = parseDurationMs(requireShellOptionValue(rest[index], option));
      expiresInSeconds = Math.ceil(durationMs / 1_000);
    }
    return json(await handleContactInviteCreate({ expiresInSeconds }, ctx));
  }
  if (action === "accept") {
    requireCommandCapability(ctx, "contact.invite.accept");
    requireArgumentCount(rest, 1, "invite accept requires: contact invite accept CODE");
    return json(await handleContactInviteAccept({ code: rest[0] }, ctx));
  }
  if (action === "list") {
    requireCommandCapability(ctx, "contact.invite.list");
    const flags = parseOnlyFlags(rest, new Set(["--all", "--json"]));
    const result = handleContactInviteList({ includeTerminal: flags.has("--all") }, ctx);
    if (flags.has("--json")) return json(result);
    const lines = ["INVITE\tSTATE\tEXPIRES\tCONTACT"];
    for (const invite of result.invites) {
      lines.push([
        invite.inviteId,
        invite.state,
        new Date(invite.expiresAtMs).toISOString(),
        invite.contactId ?? "-",
      ].join("\t"));
    }
    if (result.invites.length === 0) lines.push("(none)");
    return completed(`${lines.join("\n")}\n`);
  }
  if (action === "cancel") {
    requireCommandCapability(ctx, "contact.invite.cancel");
    requireArgumentCount(rest, 1, "invite cancel requires: contact invite cancel INVITE_ID");
    return json(handleContactInviteCancel({ inviteId: rest[0] }, ctx));
  }
  throw new Error("invite requires create, accept, list, or cancel");
}

async function manageRequest(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [action, ...rest] = args;
  if (action === "list") {
    requireCommandCapability(ctx, "contact.request.list");
    let contactId: string | undefined;
    let includeTerminal = false;
    let outputJson = false;
    for (let index = 0; index < rest.length; index += 1) {
      const option = rest[index];
      if (option === "--contact") {
        index += 1;
        contactId = requireShellOptionValue(rest[index], option);
      } else if (option === "--all") {
        includeTerminal = true;
      } else if (option === "--json") {
        outputJson = true;
      } else {
        throw new Error(`unexpected request list option: ${option}`);
      }
    }
    const result = handleContactRequestList({ contactId, includeTerminal }, ctx);
    if (outputJson) return json(result);
    const lines = ["REQUEST\tSTATE\tDIRECTION\tKIND\tTITLE"];
    for (const request of result.requests) {
      lines.push([
        request.id,
        request.state,
        request.direction,
        request.kind,
        request.title,
      ].join("\t"));
    }
    if (result.requests.length === 0) lines.push("(none)");
    return completed(`${lines.join("\n")}\n`);
  }
  if (action === "create") {
    requireCommandCapability(ctx, "contact.request.create");
    return json(await handleContactRequestCreate(parseRequestCreate(rest), ctx));
  }
  if (action === "update") {
    requireCommandCapability(ctx, "contact.request.update");
    return json(await handleContactRequestUpdate(parseRequestUpdate(rest), ctx));
  }
  throw new Error("request requires list, create, or update");
}

function parseRequestCreate(args: string[]): ContactRequestCreateArgs {
  const input: Partial<ContactRequestCreateArgs> = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    index += 1;
    const value = requireShellOptionValue(args[index], option);
    if (option === "--contact") input.contactId = value;
    else if (option === "--kind") input.kind = value;
    else if (option === "--title") input.title = value;
    else if (option === "--details") input.details = jsonObjectSchema.parse(JSON.parse(value));
    else if (option === "--delivery-id") input.idempotencyKey = value;
    else throw new Error(`unexpected request create option: ${option}`);
  }
  if (!input.contactId || !input.kind || !input.title) {
    throw new Error("request create requires --contact, --kind, and --title");
  }
  return {
    contactId: input.contactId,
    kind: input.kind,
    title: input.title,
    ...(input.details ? { details: input.details } : undefined),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined),
  };
}

function parseRequestUpdate(args: string[]): ContactRequestUpdateArgs {
  const requestId = requireShellOptionValue(args[0], "request update");
  let state: Exclude<ContactRequestState, "offered"> | undefined;
  let expectedRevision: number | undefined;
  let details: ContactRequestUpdateArgs["details"];
  let idempotencyKey: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    index += 1;
    const value = requireShellOptionValue(args[index], option);
    if (option === "--state") {
      state = requestStateSchema.parse(value);
    } else if (option === "--revision") {
      expectedRevision = Number(value);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("--revision must be a positive integer");
      }
    } else if (option === "--details") {
      details = jsonObjectSchema.parse(JSON.parse(value));
    } else if (option === "--delivery-id") {
      idempotencyKey = value;
    } else {
      throw new Error(`unexpected request update option: ${option}`);
    }
  }
  if (!state) throw new Error("request update requires --state");
  return {
    requestId,
    state,
    ...(expectedRevision !== undefined ? { expectedRevision } : undefined),
    ...(details ? { details } : undefined),
    ...(idempotencyKey ? { idempotencyKey } : undefined),
  };
}

function parseOnlyFlags(args: string[], allowed: Set<string>): Set<string> {
  const flags = new Set<string>();
  for (const argument of args) {
    if (!allowed.has(argument)) throw new Error(`unexpected option: ${argument}`);
    flags.add(argument);
  }
  return flags;
}

function requireArgumentCount(args: string[], count: number, message: string): void {
  if (args.length !== count) throw new Error(message);
}

function json<Value>(value: Value): ExecResult {
  return completed(`${JSON.stringify(value, null, 2)}\n`);
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function contactUsage(): string {
  return [
    "Usage:",
    "  contact identity",
    "  contact list [--all] [--json]",
    "  contact alias CONTACT_ID NAME|--clear",
    "  contact invite create [--expires DURATION]",
    "  contact invite accept CODE",
    "  contact invite list [--all] [--json]",
    "  contact invite cancel INVITE_ID",
    "  contact revoke CONTACT_ID",
    "  contact request list [--contact CONTACT_ID] [--all] [--json]",
    "  contact request create --contact CONTACT_ID --kind KIND --title TITLE [--details JSON] [--delivery-id ID]",
    "  contact request update REQUEST_ID --state STATE [--revision N] [--details JSON] [--delivery-id ID]",
    "",
    "Pairing and revocation require the signed-in human or their canonical Ship. Send ordinary contact messages with",
    "`message send --to CONTACT_ID --message TEXT --also`.",
    "",
  ].join("\n");
}
