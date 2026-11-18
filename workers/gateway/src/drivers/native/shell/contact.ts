import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type {
  ApproachResult,
  ApproachSummary,
  ContactRequestCreateArgs,
  ContactRequestState,
  ContactRequestUpdateArgs,
} from "@humansandmachines/gsv/protocol";
import { contactDisplayName, contactInviteUrl, jsonObjectSchema, profileContactPolicy } from "@humansandmachines/gsv/protocol";
import { deploymentPresentation } from "@humansandmachines/gsv/services/deployment";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import { handleApproachCreate } from "../../../kernel/approaches/admission";
import { expireOverdueApproach } from "../../../kernel/approaches/runtime";
import { requireContactCaller } from "../../../kernel/federation/authority";
import { sha256Base64Url } from "../../../kernel/federation-crypto";
import {
  handleContactAliasSet,
  handleContactList,
  handleContactRequestCreate,
  handleContactRequestList,
  handleContactRequestUpdate,
  handleContactRevoke,
} from "../../../kernel/federation";
import { handleContactPreferencesUpdate } from "../../../kernel/federation/preferences";
import { handleProfileResolve, ownerDisplayName } from "../../../kernel/profiles";
import { shipAddress } from "../../../installation/identity";
import { requireCommandCapability, requireShellOptionValue } from "./common";
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
    case "find":
      requireCommandCapability(ctx, "profile.resolve");
      requireArgumentCount(rest, 1, "find requires: contact find @HANDLE|ADDRESS");
      return json(await handleProfileResolve({ address: rest[0] }, ctx));
    case "connect":
      requireCommandCapability(ctx, "approach.create");
      return json(await connectToPerson(rest, ctx));
    case "list":
      return await listContacts(rest, ctx);
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
      return inviteLink(rest, ctx);
    case "handling": {
      requireCommandCapability(ctx, "contact.preferences.update");
      requireArgumentCount(rest, 4, "handling requires: contact handling CONTACT_ID manual|ship --revision N");
      const expectedRevision = Number(rest[3]);
      if (rest[2] !== "--revision" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error("handling requires --revision with the current preferences revision from contact list --json");
      }
      return json(await handleContactPreferencesUpdate({ contactId: rest[0], expectedRevision,
        patch: { shipHandlesMessages: parseHandling(rest[1]) } }, ctx));
    }
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

async function listContacts(args: string[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "contact.list");
  const flags = parseOnlyFlags(args, new Set(["--all", "--json"]));
  const result = await handleContactList({ includeRevoked: flags.has("--all") }, ctx);
  if (flags.has("--json")) return json(result);
  const lines = ["CONTACT\tSTATE\tNAME\tADDRESS"];
  for (const contact of result.contacts) {
    lines.push([
      contact.id,
      contact.state,
      contactDisplayName(contact),
      // Only a contact that ended before DIDs names none.
      contact.remoteHandle ? `@${contact.remoteHandle}` : contact.remoteDid ?? "(before DIDs)",
    ].join("\t"));
  }
  if (result.contacts.length === 0) lines.push("(none)");
  return completed(`${lines.join("\n")}\n`);
}

/** The owner's invitation link; it carries no secret, and says when no one can send a request from it yet. */
function inviteLink(args: string[], ctx: KernelContext): ExecResult {
  requireCommandCapability(ctx, "profile.get");
  requireArgumentCount(args, 0, "invite takes no arguments: contact invite");
  const ownerUid = requireContactCaller(ctx, false);
  const presentation = deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG);
  const origin = shipAddress(ctx.installationIdentity, presentation.primaryDomain)?.origin ?? ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("This Ship has no address to invite people to");
  const url = contactInviteUrl(origin, presentation);
  const published = ctx.profiles.published(ownerUid);
  if (published && profileContactPolicy(published.record.contactPolicy) === "requests") return completed(`${url}\n`);
  return completed(`${url}\nNo one can send a request from it yet: the owner's profile must be public with message requests on (People → Profile).\n`);
}

/**
 * Send a first message request to a published profile. The owner's canonical
 * Ship may do this for them; the recipient still decides whether to accept.
 */
async function connectToPerson(args: string[], ctx: KernelContext): Promise<ApproachResult> {
  const address = requireShellOptionValue(args[0], "connect");
  let text: string | undefined;
  let displayName: string | undefined;
  let shipHandlesMessages: boolean | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = requireShellOptionValue(args[index + 1], option);
    if (option === "--message" && text === undefined) text = value;
    else if (option === "--name" && displayName === undefined) displayName = value;
    else if (option === "--handling" && shipHandlesMessages === undefined) shipHandlesMessages = parseHandling(value);
    else throw new Error(`unexpected or repeated connect option: ${option}`);
  }
  if (!text?.trim()) throw new Error("connect requires --message TEXT");
  if (shipHandlesMessages === undefined) throw new Error("Ask the owner who should handle new messages, then use --handling manual|ship");
  // Only the signed-in human or their canonical Ship may send, or replay, a message request.
  requireContactCaller(ctx, true);
  const { profile } = await handleProfileResolve({ address }, ctx);
  const ownerUid = resolveCallerOwnerUid(ctx);
  const name = displayName ?? ownerDisplayName(ownerUid, ctx);
  if (!name?.trim()) throw new Error("connect requires --name DISPLAY_NAME");
  // The same message to the same person is one request while it is still open; once it has
  // ended, sending it again is a new request.
  const base = `${profile.did}\n${text}`;
  let idempotencyKey = `connect:${await sha256Base64Url(base)}`;
  for (let previous = ctx.approaches.byIdempotencyKey(ownerUid, idempotencyKey); previous;
    previous = ctx.approaches.byIdempotencyKey(ownerUid, idempotencyKey)) {
    if (!approachEnded(previous.summary)) {
      if (["preparing", "pending"].includes(previous.summary.state)
        && (previous.shipHandlesMessages !== shipHandlesMessages || previous.localDisplayName !== name)) {
        throw new Error("This message request is already waiting for an answer; withdraw it before sending it with a different name or handling");
      }
      return { approach: previous.summary };
    }
    idempotencyKey = `connect:${await sha256Base64Url(`${base}\n${previous.summary.id}`)}`;
  }
  const open = ctx.approaches.unresolved(ownerUid, profile.did);
  // A request past its deadline may still read as pending until maintenance reaches it; expire that
  // exact request now so the replacement is not refused as a duplicate.
  if (open) await expireOverdueApproach(open, ctx);
  return await handleApproachCreate({
    did: profile.did, profileCid: profile.cid, displayName: name, text, shipHandlesMessages, idempotencyKey,
  }, ctx);
}

function approachEnded(approach: Pick<ApproachSummary, "state" | "expiresAtMs">): boolean {
  return ["declined", "withdrawn", "expired", "blocked"].includes(approach.state)
    // A request still preparing or pending past its deadline has ended too; maintenance just hasn't
    // recorded it yet. Accepting requests keep their receipt grace and are not ended here.
    || (["preparing", "pending"].includes(approach.state) && approach.expiresAtMs <= Date.now());
}

function parseHandling(value: string): boolean {
  if (value === "manual") return false;
  if (value === "ship") return true;
  throw new Error("handling must be manual or ship");
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
    const lines = ["REQUEST\tSTATE\tEXCHANGE\tDIRECTION\tKIND\tTITLE"];
    for (const request of result.requests) {
      lines.push([
        request.id,
        request.state,
        request.exchange?.state ?? "unconfirmed",
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
    "  contact find @HANDLE|ADDRESS",
    "  contact connect @HANDLE|ADDRESS --message TEXT --handling manual|ship [--name DISPLAY_NAME]",
    "  contact list [--all] [--json]",
    "  contact alias CONTACT_ID NAME|--clear",
    "  contact invite",
    "  contact handling CONTACT_ID manual|ship --revision N",
    "  contact revoke CONTACT_ID",
    "  contact request list [--contact CONTACT_ID] [--all] [--json]",
    "  contact request create --contact CONTACT_ID --kind KIND --title TITLE [--details JSON] [--delivery-id ID]",
    "  contact request update REQUEST_ID --state STATE [--revision N] [--details JSON] [--delivery-id ID]",
    "",
    "Ask the owner who should handle new messages unless they already chose. manual leaves messages for the owner;",
    "ship lets Ship handle future incoming messages. The choice affects only this owner's side and can change later.",
    "Profiles are public by default. connect finds the person's profile and sends them a first message request;",
    "they decide whether to accept. The request fails if the profile is unavailable or not receiving requests.",
    "invite prints the owner's invitation link. It never expires and anyone may use it: whoever opens it creates or signs",
    "in to their Ship and sends the owner an ordinary message request, which works only while the owner's profile is",
    "public with requests on. To invite someone at a known email address, send the link with mail send; see mail help.",
    "Otherwise share the link with the owner. Sending a link does not mean anyone has connected.",
    "Pairing, handling changes and revocation require the signed-in human or their canonical Ship. Send ordinary contact messages with",
    "`message send --to CONTACT_ID --message TEXT --also`.",
    "",
  ].join("\n");
}
