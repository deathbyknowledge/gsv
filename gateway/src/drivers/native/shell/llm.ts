import { defineCommand, type Command, type CommandContext, type ExecResult } from "just-bash";
import type {
  AiTextGenerateConfig,
  AiTextGenerateResult,
  AiTextGenerateOptions,
} from "@humansandmachines/gsv/protocol";
import { handleAiTextGenerate } from "../../../kernel/ai";
import type { KernelContext } from "../../../kernel/context";
import type { NetFetchDeviceTransport } from "../../../kernel/net";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type ParsedArgs = {
  options: Map<string, string | true>;
  positionals: string[];
};

export function buildLlmCommand(
  ctx: KernelContext,
  transport?: NetFetchDeviceTransport,
): Command {
  return defineCommand("llm", async (args, commandCtx): Promise<ExecResult> => {
    try {
      return await runLlm(args, commandCtx, ctx, transport);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `llm: ${message}\n`, exitCode: 1 };
    }
  });
}

async function runLlm(
  args: string[],
  shellCtx: CommandContext,
  ctx: KernelContext,
  transport?: NetFetchDeviceTransport,
): Promise<ExecResult> {
  const parsed = parseArgs(args, {
    boolean: ["help", "json"],
    value: ["system", "preset", "provider", "model", "max-tokens", "reasoning", "timeout-ms"],
    aliases: { h: "help" },
  });
  if (hasOption(parsed, "help")) {
    return ok(llmUsage());
  }

  requireCommandCapability(ctx, "ai.text.generate");
  const prompt = readTextArgument(parsed.positionals, shellCtx);
  const result = await handleAiTextGenerate(
    {
      systemPrompt: optionValue(parsed, "system"),
      messages: [{
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      }],
      config: buildLlmConfig(parsed),
      options: buildLlmOptions(parsed),
      sessionAffinityKey: "shell:llm",
    },
    ctx,
    transport,
  );

  assertSuccessfulGeneration(result);

  if (hasOption(parsed, "json")) {
    return okJson(result);
  }
  return ok(`${result.text ?? ""}\n`);
}

function assertSuccessfulGeneration(result: AiTextGenerateResult): void {
  const stopReason = result.message.stopReason;
  if (stopReason !== "error" && stopReason !== "aborted") {
    return;
  }
  throw new Error(result.message.errorMessage || `generation ended with ${stopReason}`);
}

function buildLlmConfig(parsed: ParsedArgs): AiTextGenerateConfig | undefined {
  const overrides: Record<string, string> = {};
  const provider = optionValue(parsed, "provider");
  if (provider) {
    overrides["config/ai/provider"] = provider;
  }
  const model = optionValue(parsed, "model");
  if (model) {
    overrides["config/ai/model"] = model;
  }
  const preset = optionValue(parsed, "preset");
  if (!preset && Object.keys(overrides).length === 0) {
    return undefined;
  }
  return {
    ...(preset ? { preset: { id: preset } } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

function buildLlmOptions(parsed: ParsedArgs): AiTextGenerateOptions | undefined {
  const options: AiTextGenerateOptions = {};
  const maxTokens = parsePositiveIntOption(optionValue(parsed, "max-tokens"), "--max-tokens");
  if (maxTokens !== undefined) {
    options.maxTokens = maxTokens;
  }
  const timeoutMs = parsePositiveIntOption(optionValue(parsed, "timeout-ms"), "--timeout-ms");
  if (timeoutMs !== undefined) {
    options.timeoutMs = timeoutMs;
  }
  const reasoning = optionValue(parsed, "reasoning");
  if (reasoning !== undefined) {
    options.reasoning = normalizeReasoning(reasoning);
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function parseArgs(
  args: string[],
  spec: {
    boolean: readonly string[];
    value: readonly string[];
    aliases?: Record<string, string>;
  },
): ParsedArgs {
  const booleanOptions = new Set(spec.boolean);
  const valueOptions = new Set(spec.value);
  const aliases = spec.aliases ?? {};
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const equalsIndex = arg.indexOf("=");
      const rawName = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
      const name = aliases[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        if (equalsIndex >= 0) {
          throw new Error(`--${rawName} does not take a value`);
        }
        options.set(name, true);
        continue;
      }
      if (valueOptions.has(name)) {
        const value = equalsIndex >= 0
          ? arg.slice(equalsIndex + 1)
          : requireShellOptionValue(args[++index], `--${rawName}`);
        options.set(name, value);
        continue;
      }
      throw new Error(`unsupported option: --${rawName}`);
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const rawName = arg.slice(1);
      const name = aliases[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        options.set(name, true);
        continue;
      }
      if (valueOptions.has(name)) {
        options.set(name, requireShellOptionValue(args[++index], `-${rawName}`));
        continue;
      }
      throw new Error(`unsupported option: -${rawName}`);
    }
    positionals.push(arg);
  }

  return { options, positionals };
}

function hasOption(parsed: ParsedArgs, name: string): boolean {
  return parsed.options.get(name) === true;
}

function optionValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePositiveIntOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeReasoning(value: string): NonNullable<AiTextGenerateOptions["reasoning"]> {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "inherit" ||
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error("--reasoning must be inherit, off, minimal, low, medium, high, or xhigh");
}

function readTextArgument(positionals: string[], ctx: CommandContext): string {
  const text = positionals.join(" ").trim() || ctx.stdin.trim();
  if (!text) {
    throw new Error("prompt is required");
  }
  return text;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function okJson(value: unknown): ExecResult {
  return ok(`${JSON.stringify(value, null, 2)}\n`);
}

function llmUsage(): string {
  return [
    "llm [OPTIONS] PROMPT...",
    "",
    "Generate one assistant response with the configured text model.",
    "",
    "Options:",
    "  --system TEXT",
    "  --preset NAME_OR_ID",
    "  --provider PROVIDER",
    "  --model MODEL",
    "  --max-tokens N",
    "  --reasoning inherit|off|minimal|low|medium|high|xhigh",
    "  --timeout-ms N",
    "  --json",
    "",
  ].join("\n");
}
