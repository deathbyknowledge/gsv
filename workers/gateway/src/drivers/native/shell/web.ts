import { defineCommand, type ExecResult } from "just-bash";
import type { WebSearchArgs } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { handleWebSearch } from "../../../kernel/web-search";
import { requireShellOptionValue } from "./common";

const USAGE = "Usage: web search [--limit 1..10] [--include-domain HOST] [--exclude-domain HOST] [--json] QUERY...\n";

export function buildWebCommand(ctx: KernelContext) {
  return defineCommand("web", async (args, shellCtx): Promise<ExecResult> => {
    try {
      if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return { stdout: USAGE, stderr: "", exitCode: 0 };
      if (args[0] !== "search") throw new Error(USAGE.trim());
      const request: WebSearchArgs = { query: "" };
      const words: string[] = [];
      let json = false;
      for (let i = 1; i < args.length; i++) {
        const value = args[i];
        if (value === "--") { words.push(...args.slice(i + 1)); break; }
        if (value === "--json") { json = true; continue; }
        if (value === "--limit") {
          request.limit = Number(requireShellOptionValue(args[++i], value));
          continue;
        }
        if (value === "--include-domain" || value === "--exclude-domain") {
          const key = value === "--include-domain" ? "includeDomains" : "excludeDomains";
          (request[key] ??= []).push(requireShellOptionValue(args[++i], value));
          continue;
        }
        if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
        words.push(value);
      }
      request.query = words.join(" ");
      const signal = ctx.requestSignal && shellCtx.signal
        ? AbortSignal.any([ctx.requestSignal, shellCtx.signal])
        : ctx.requestSignal ?? shellCtx.signal;
      const result = await handleWebSearch(request, { ...ctx, requestSignal: signal });
      const output = json ? JSON.stringify(result) : result.results.length === 0 ? "No results." : result.results.map((hit, i) =>
        `${i + 1}. ${hit.title}\n${hit.url}${hit.publishedAt ? `\nPublished: ${hit.publishedAt}` : ""}\n${hit.snippet}`,
      ).join("\n\n");
      return { stdout: `${output}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `web: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
