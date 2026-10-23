import { defineCommand } from "just-bash";
import type { CommandContext, ExecResult } from "just-bash";
import { cancelBinaryBody, inferFsContentType, jsonObjectSchema, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { BinaryBody, JsonObject, JsonValue } from "@humansandmachines/gsv/protocol";
import type { PublicRecordWrite } from "@humansandmachines/gsv/services/pds";
import type { GsvFs } from "../../../fs/gsv-fs";
import { handleAtprotoBlobUpload, handleAtprotoIdentity, handleAtprotoWrite, parseAtprotoWrites } from "../../../kernel/atproto";
import type { KernelContext } from "../../../kernel/context";
import { requireCommandCapability, requireShellOptionValue } from "./common";

/** A record file is read whole, and one approval shows at most this much. */
const MAX_RECORD_FILE_BYTES = 64 * 1024;

const ATPROTO_USAGE = `Usage:
  atproto identity
  atproto create COLLECTION [--rkey RKEY] (--json RECORD | --file PATH)
  atproto put COLLECTION RKEY (--json RECORD | --file PATH)
  atproto delete COLLECTION RKEY
  atproto apply (--json WRITES | --file PATH)
  atproto blob PATH [--mime TYPE]

Records are public on the open network under the Ship's address. The person
approves each publish unless they allowed it. A record's $type defaults to its
collection. Upload a file with atproto blob, then put the reference it prints
in a record to publish the file with it.
`;

export function buildAtprotoCommand(fs: GsvFs, ctx: KernelContext) {
  return defineCommand("atproto", async (args, shellCtx): Promise<ExecResult> => {
    try {
      const signal = ctx.requestSignal && shellCtx.signal
        ? AbortSignal.any([ctx.requestSignal, shellCtx.signal])
        : ctx.requestSignal ?? shellCtx.signal;
      return await runAtprotoCommand(args, shellCtx, fs, { ...ctx, requestSignal: signal });
    } catch (error) {
      return { stdout: "", stderr: `atproto: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}

async function runAtprotoCommand(args: string[], shellCtx: CommandContext, fs: GsvFs, ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;
  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return completed(ATPROTO_USAGE);
    case "identity":
      requireCommandCapability(ctx, "atproto.identity");
      if (rest.length > 0) throw new Error("identity accepts no arguments");
      return json(await handleAtprotoIdentity(ctx));
    case "create": {
      const { positional, options } = parseOptions(rest, ["--rkey", "--json", "--file"]);
      if (positional.length !== 1) throw new Error("create requires: atproto create COLLECTION [--rkey RKEY] (--json RECORD | --file PATH)");
      const [collection] = positional;
      const record = typedRecord(await recordInput(options, shellCtx, fs), collection);
      const rkey = options.get("--rkey");
      return await write([rkey === undefined ? { action: "create", collection, record } : { action: "create", collection, rkey, record }], ctx);
    }
    case "put": {
      const { positional, options } = parseOptions(rest, ["--json", "--file"]);
      if (positional.length !== 2) throw new Error("put requires: atproto put COLLECTION RKEY (--json RECORD | --file PATH)");
      const [collection, rkey] = positional;
      return await write([{ action: "put", collection, rkey, record: typedRecord(await recordInput(options, shellCtx, fs), collection) }], ctx);
    }
    case "delete": {
      const { positional } = parseOptions(rest, []);
      if (positional.length !== 2) throw new Error("delete requires: atproto delete COLLECTION RKEY");
      const [collection, rkey] = positional;
      return await write([{ action: "delete", collection, rkey }], ctx);
    }
    case "apply": {
      const { positional, options } = parseOptions(rest, ["--json", "--file"]);
      if (positional.length > 0) throw new Error("apply requires: atproto apply (--json WRITES | --file PATH)");
      const writes = await jsonInput(options, shellCtx, fs);
      if (!Array.isArray(writes)) throw new Error("apply expects a JSON array of writes");
      return await write(parseAtprotoWrites(writes).map((change) =>
        change.action === "delete" ? change : { ...change, record: typedRecord(change.record, change.collection) }), ctx);
    }
    case "blob":
      return await uploadBlob(rest, shellCtx, fs, ctx);
    default:
      throw new Error(`unknown command: ${subcommand}\n${ATPROTO_USAGE}`);
  }
}

async function write(writes: PublicRecordWrite[], ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "atproto.write");
  return json(await handleAtprotoWrite({ writes }, ctx));
}

async function uploadBlob(args: string[], shellCtx: CommandContext, fs: GsvFs, ctx: KernelContext): Promise<ExecResult> {
  requireCommandCapability(ctx, "atproto.blob.upload");
  const { positional, options } = parseOptions(args, ["--mime"]);
  if (positional.length !== 1) throw new Error("blob requires: atproto blob PATH [--mime TYPE]");
  const path = shellCtx.fs.resolvePath(shellCtx.cwd, positional[0]);
  const opened = await fs.openFile(path);
  if (!opened.body) throw new Error(`cannot read ${path}`);
  const body: BinaryBody = { stream: opened.body, length: opened.size };
  try {
    const mimeType = (options.get("--mime") ?? opened.contentType ?? inferFsContentType(path)).split(";", 1)[0].trim();
    return json(await handleAtprotoBlobUpload({ mimeType }, ctx, body));
  } catch (error) {
    await cancelBinaryBody(body, error);
    throw error;
  }
}

/** A record's type defaults to the collection it is written to. */
function typedRecord(record: JsonObject, collection: string): JsonObject {
  return "$type" in record ? record : { $type: collection, ...record };
}

async function recordInput(options: Map<string, string>, shellCtx: CommandContext, fs: GsvFs): Promise<JsonObject> {
  const record = jsonObjectSchema.safeParse(await jsonInput(options, shellCtx, fs));
  if (!record.success) throw new Error("a record must be a JSON object");
  return record.data;
}

async function jsonInput(options: Map<string, string>, shellCtx: CommandContext, fs: GsvFs): Promise<JsonValue> {
  const inline = options.get("--json");
  const file = options.get("--file");
  let text: string;
  if (inline !== undefined && file === undefined) {
    text = inline;
  } else if (file !== undefined && inline === undefined) {
    const path = shellCtx.fs.resolvePath(shellCtx.cwd, file);
    const stat = await fs.stat(path);
    if (!stat.isFile) throw new Error(`not a file: ${file}`);
    if (stat.size > MAX_RECORD_FILE_BYTES) throw new Error(`${file} exceeds ${MAX_RECORD_FILE_BYTES / 1024} KiB`);
    text = await fs.readFile(path);
  } else {
    throw new Error("give the JSON with either --json or --file");
  }
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file ?? "--json"} is not valid JSON`);
  }
}

function parseOptions(args: string[], allowed: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }
    if (!allowed.includes(current)) throw new Error(`unexpected option: ${current}`);
    if (options.has(current)) throw new Error(`${current} given twice`);
    index += 1;
    options.set(current, requireShellOptionValue(args[index], current));
  }
  return { positional, options };
}

function json<Value>(value: Value): ExecResult {
  return completed(`${JSON.stringify(value, null, 2)}\n`);
}

function completed(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}
