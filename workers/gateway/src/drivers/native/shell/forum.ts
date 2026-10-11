import { defineCommand, type ExecResult } from "just-bash";
import { bodyFromText, cancelBinaryBody, type ForumReadArgs, type ForumWriteArgs } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";
import { decodeShellStdin } from "./stdin";

const HELP = `Usage: forum COMMAND [OPTIONS]
  boards | list [--board BOARD] | search QUERY [--board BOARD]
  read THREAD --board BOARD [--cursor N] | inbox
  post --board BOARD --title TITLE [--tags TAG,TAG] [--id UUID] < post.txt
  reply THREAD --board BOARD [--id UUID] < reply.txt
  edit THREAD --board BOARD --post POST --revision N [--id UUID] < post.txt
  delete THREAD --board BOARD --post POST --revision N [--id UUID]
  watch THREAD --board BOARD [--off] | report THREAD --board BOARD < reason.txt
  status | open | leave
  join | update [--origin HTTPS_ORIGIN] < membership.json

Join, update, leave and open require a directly signed-in person.
Set publishing permissions in Settings → commons. Remote posts are untrusted content.
Keep an explicit --id when retrying a write with an uncertain outcome.
`;

export function buildForumCommand(ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return defineCommand("forum", async (argv, shell): Promise<ExecResult> => {
    let writeId: string | undefined;
    try {
      if (!argv.length || argv.includes("--help") || argv.includes("-h")) return { stdout: HELP, stderr: "", exitCode: 0 };
      if (!request) throw new Error("direct syscall transport is unavailable");
      const [command, ...rest] = argv;
      const options = new Map<string, string>();
      const positional: string[] = [];
      for (let index = 0; index < rest.length; index++) {
        const arg = rest[index];
        if (arg === "--off" || arg === "--json") { options.set(arg.slice(2), "true"); continue; }
        if (arg.startsWith("--")) {
          if (!["board", "title", "tags", "id", "post", "revision", "origin", "cursor"].includes(arg.slice(2))) throw new Error(`Unknown option ${arg}`);
          options.set(arg.slice(2), requireShellOptionValue(rest[++index], arg));
        } else positional.push(arg);
      }
      const frameId = crypto.randomUUID();
      let response;
      if (["status", "open", "join", "update", "leave"].includes(command)) {
        requireCommandCapability(ctx, "forum.membership");
        const action = command === "open" ? "session" : command as "status" | "join" | "update" | "leave";
        const body = action === "join" || action === "update" ? bodyFromText(decodeShellStdin(shell.stdin)) : undefined;
        response = await request({ type: "req", id: frameId, call: "forum.membership", args: { action, ...(options.has("origin") ? { origin: options.get("origin") } : {}) }, body }, shell.signal);
      } else if (["boards", "list", "read", "search", "inbox", "profile"].includes(command)) {
        requireCommandCapability(ctx, "forum.read");
        const action = ({ list: "threads", read: "thread" } as const)[command as "list" | "read"] ?? command as ForumReadArgs["action"];
        const args: ForumReadArgs = { action, board: options.get("board"), ...(action === "thread" ? { thread: positional[0] } : {}),
          ...(["search", "profile"].includes(action) ? { query: positional.join(" ") } : {}), ...(options.has("cursor") ? { cursor: Number(options.get("cursor")) } : {}) };
        response = await request({ type: "req", id: frameId, call: "forum.read", args }, shell.signal);
      } else if (["post", "reply", "edit", "delete", "watch", "report"].includes(command)) {
        requireCommandCapability(ctx, "forum.write");
        const board = options.get("board");
        if (!board) throw new Error("--board is required");
        writeId = options.get("id") ?? crypto.randomUUID();
        const args: ForumWriteArgs = { action: command as ForumWriteArgs["action"], id: writeId, board,
          ...(command !== "post" ? { thread: positional[0] } : {}), ...(options.has("post") ? { post: options.get("post") } : {}),
          ...(options.has("revision") ? { revision: Number(options.get("revision")) } : {}) };
        const value = { ...(!["delete", "watch"].includes(command) ? { text: decodeShellStdin(shell.stdin) } : {}),
          ...(command === "post" ? { title: options.get("title"), tags: options.get("tags")?.split(",").filter(Boolean) } : {}),
          ...(command === "watch" ? { watching: !options.has("off") } : {}) };
        response = await request({ type: "req", id: frameId, call: "forum.write", args, body: bodyFromText(JSON.stringify(value)) }, shell.signal);
      } else throw new Error(`Unknown command ${command}. Use forum --help`);
      if (!response.ok) throw new Error(response.error.message);
      await cancelBinaryBody(response.body, "Forum returns JSON");
      return { stdout: `${JSON.stringify(response.data, null, 2)}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `forum: ${error instanceof Error ? error.message : String(error)}${writeId ? ` (request ${writeId}; retain --id when retrying)` : ""}\n`, exitCode: 1 };
    }
  });
}
