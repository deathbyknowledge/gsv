import { defineCommand, type ExecResult } from "just-bash";
import type { WebSearchArgs } from "@humansandmachines/gsv/protocol";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import { webSearchArgsSchema, webSearchResultSchema } from "@humansandmachines/gsv/services/web-search";
import type { KernelContext } from "../../../kernel/context";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const USAGE = "Usage: web search [--target TARGET] [--limit 1..10] [--include-domain HOST] [--exclude-domain HOST] [--json] QUERY...\n";

export function buildWebCommand(ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return defineCommand("web", async (args, shellCtx): Promise<ExecResult> => {
    try {
      if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return { stdout: USAGE, stderr: "", exitCode: 0 };
      if (args[0] !== "search") throw new Error(USAGE.trim());
      const input: WebSearchArgs = { query: "" };
      const words: string[] = [];
      let json = false;
      for (let i = 1; i < args.length; i++) {
        const value = args[i];
        if (value === "--") { words.push(...args.slice(i + 1)); break; }
        if (value === "--json") { json = true; continue; }
        if (value === "--target") {
          input.target = requireShellOptionValue(args[++i], value);
          continue;
        }
        if (value === "--limit") {
          input.limit = Number(requireShellOptionValue(args[++i], value));
          continue;
        }
        if (value === "--include-domain" || value === "--exclude-domain") {
          const key = value === "--include-domain" ? "includeDomains" : "excludeDomains";
          (input[key] ??= []).push(requireShellOptionValue(args[++i], value));
          continue;
        }
        if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
        words.push(value);
      }
      input.query = words.join(" ");
      requireCommandCapability(ctx, "web.search");
      const searchArgs = webSearchArgsSchema.parse(input);
      if (!request) throw new Error("direct syscall transport is unavailable");
      const signal = ctx.requestSignal && shellCtx.signal
        ? AbortSignal.any([ctx.requestSignal, shellCtx.signal])
        : ctx.requestSignal ?? shellCtx.signal;
      signal?.throwIfAborted();
      const response = await request({ type: "req", id: crypto.randomUUID(), call: "web.search", args: searchArgs }, signal);
      if (!response.ok) throw new Error(response.error.message);
      await cancelBinaryBody(response.body, "Web search returns structured results");
      signal?.throwIfAborted();
      const result = webSearchResultSchema.parse(response.data);
      const output = json ? JSON.stringify(result) : result.results.length === 0 ? "No results." : result.results.map((hit, i) =>
        `${i + 1}. ${hit.title}\n${hit.url}${hit.publishedAt ? `\nPublished: ${hit.publishedAt}` : ""}\n${hit.snippet}`,
      ).join("\n\n");
      return { stdout: `${output}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `web: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
