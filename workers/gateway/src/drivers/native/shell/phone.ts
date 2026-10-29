import { defineCommand, type CommandContext, type ExecResult } from "just-bash";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { RequestFrame } from "../../../protocol/frames";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const MAX_BRIEF_FILE_BYTES = 16 * 1024;

const USAGE = `Usage:
  phone call --work RESPONSIBILITY_ID (--file BRIEF.json | --json BRIEF)
  phone list [--all]
  phone get CALL_ID
  phone answer CALL_ID QUESTION_ID ANSWER...
  phone note CALL_ID NOTE...
  phone end CALL_ID

A voice agent places the call and keeps to the brief; you do not speak on it.
The brief is a JSON object:
  to            international number, for example +34910000000
  business      how the agent addresses the callee (optional)
  onBehalfOf    the name the agent gives in its first sentence (optional: defaults to the
                owner's name; if they have not set one, the command says to ask them)
  goal          what the call must achieve
  mayShare      facts the agent may say (optional list)
  mustNot       limits the agent never crosses (optional list)
  ifOutsideLimits  ask (default) or end
  checkIn       when the agent stops and asks the owner, holding the line (optional),
                for example "after they give their answer, before ending the call"
  voicemail     hang_up (default) or leave_message
  language      BCP 47 language to open in (optional)
  maxMinutes    capped by the Ship's allowance (optional)

The owner approves every call, with its brief, before it dials. One command places
at most one call; nothing redials. Calling returns at once. The responsibility waits on the call; a question from the
agent and the call's end arrive as events. Answer a question quickly with
phone answer: the callee is waiting. Cancelling your run does not hang up; phone end does.
`;

export function buildPhoneCommand(fs: GsvFs, ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return defineCommand("phone", async (args, shellCtx): Promise<ExecResult> => {
    try {
      const [verb, ...rest] = args;
      if (!verb || ["help", "--help", "-h"].includes(verb)) return { stdout: USAGE, stderr: "", exitCode: 0 };
      const frame = await phoneFrame(verb, rest, shellCtx, fs);
      requireCommandCapability(ctx, frame.call);
      if (!request) throw new Error("direct syscall transport is unavailable");
      const signal = ctx.requestSignal && shellCtx.signal
        ? AbortSignal.any([ctx.requestSignal, shellCtx.signal])
        : ctx.requestSignal ?? shellCtx.signal;
      const response = await request(frame, signal);
      if (!response.ok) throw new Error(response.error.message);
      await cancelBinaryBody(response.body, "Phone commands return metadata only");
      return { stdout: `${JSON.stringify(response.data, null, 2)}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `phone: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}

async function phoneFrame(verb: string, args: string[], shellCtx: CommandContext, fs: GsvFs): Promise<RequestFrame> {
  const id = crypto.randomUUID();
  switch (verb) {
    case "call": {
      const options = new Map<string, string>();
      for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (!["--work", "--file", "--json"].includes(option) || options.has(option)) throw new Error(`unexpected argument: ${option}\n${USAGE}`);
        options.set(option, requireShellOptionValue(args[++i], option));
      }
      const brief = await briefInput(options, shellCtx, fs);
      const responsibilityId = options.get("--work");
      return { type: "req", id, call: "sys.phone.call", args: { brief, ...(responsibilityId ? { responsibilityId } : {}) } };
    }
    case "list":
      if (args.some((arg) => arg !== "--all")) throw new Error("list accepts only --all");
      return { type: "req", id, call: "sys.phone.list", args: { includeEnded: args.includes("--all") } };
    case "get":
    case "end":
      if (args.length !== 1) throw new Error(`${verb} requires: phone ${verb} CALL_ID`);
      return { type: "req", id, call: verb === "get" ? "sys.phone.get" : "sys.phone.end", args: { callId: args[0] } };
    case "answer":
      if (args.length < 3) throw new Error("answer requires: phone answer CALL_ID QUESTION_ID ANSWER...");
      return { type: "req", id, call: "sys.phone.answer", args: { callId: args[0], questionId: args[1], answer: args.slice(2).join(" ") } };
    case "note":
      if (args.length < 2) throw new Error("note requires: phone note CALL_ID NOTE...");
      return { type: "req", id, call: "sys.phone.note", args: { callId: args[0], note: args.slice(1).join(" ") } };
    default:
      throw new Error(`unknown command: ${verb}\n${USAGE}`);
  }
}

/** The service validates the brief's fields; the command only reads one JSON object. */
async function briefInput(options: Map<string, string>, shellCtx: CommandContext, fs: GsvFs) {
  const inline = options.get("--json");
  const file = options.get("--file");
  let text: string;
  if (inline !== undefined && file === undefined) {
    text = inline;
  } else if (file !== undefined && inline === undefined) {
    const path = shellCtx.fs.resolvePath(shellCtx.cwd, file);
    const stat = await fs.stat(path);
    if (!stat.isFile) throw new Error(`not a file: ${file}`);
    if (stat.size > MAX_BRIEF_FILE_BYTES) throw new Error(`${file} exceeds ${MAX_BRIEF_FILE_BYTES / 1024} KiB`);
    text = await fs.readFile(path);
  } else {
    throw new Error("give the brief with either --file or --json");
  }
  let brief: unknown;
  try {
    brief = JSON.parse(text);
  } catch {
    throw new Error(`${file ?? "--json"} is not valid JSON`);
  }
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw new Error("the brief must be a JSON object");
  // SAFETY: The Kernel parses the brief with the shared schema before approval or dialling.
  return brief as Extract<RequestFrame, { call: "sys.phone.call" }>["args"]["brief"];
}
